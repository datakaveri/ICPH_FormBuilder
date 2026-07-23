#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const icphRoot = path.resolve(appRoot, "..");
const apiPort = Number(process.env.ICPH_SMOKE_API_PORT || 8797);
const apiBase = `http://localhost:${apiPort}`;
const testXlsxPath = path.join(icphRoot, "ODK", "ICPH_All_Question_Types_Test_v2023.1.xlsx");
const testAssetsDir = path.join(icphRoot, "ODK", "ICPH_All_Question_Types_Test_assets");
const fatalInjuryXlsxPath = path.join(icphRoot, "ODK", "fatal_injury_surveillance_form.xlsx");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, error: text || response.statusText || "Request failed" };
  }
  if (!response.ok || data.ok === false) {
    throw new Error(`${options.method || "GET"} ${pathname}: ${data.error || data.stderr || response.statusText}`);
  }
  return data;
}

function postJson(pathname, payload) {
  return requestJson(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

function deleteJson(pathname) {
  return requestJson(pathname, { method: "DELETE" });
}

async function waitForApi(child) {
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (exited) throw new Error("API server exited before becoming healthy.");
    try {
      await requestJson("/api/health");
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Timed out waiting for API health check.");
}

function startApi() {
  return spawn("node", ["server/index.js"], {
    cwd: appRoot,
    env: {
      ...process.env,
      ICPH_FORM_BUILDER_API_PORT: String(apiPort)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function filePayload(filePath, filename = path.basename(filePath)) {
  const dataBase64 = (await readFile(filePath)).toString("base64");
  return { filename, dataBase64 };
}

async function expectRejected(label, fn) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

async function main() {
  if (!existsSync(testXlsxPath)) throw new Error(`Missing smoke XLSForm: ${testXlsxPath}`);
  if (!existsSync(testAssetsDir)) throw new Error(`Missing smoke asset folder: ${testAssetsDir}`);

  const child = startApi();
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  let workspaceId = "";
  let fatalWorkspaceId = "";
  try {
    await waitForApi(child);

    await expectRejected("Bad workspace attachment route", () =>
      postJson("/api/forms/not-a-real-workspace/attachments", {
        filename: "should-not-create.txt",
        dataBase64: Buffer.from("bad").toString("base64")
      })
    );
    await expectRejected("Bad workspace entries route", () =>
      requestJson("/api/forms/not-a-real-workspace/entries")
    );
    await expectRejected("Bad workspace FHIR route", () =>
      requestJson("/api/forms/not-a-real-workspace/fhir")
    );

    const imported = await postJson("/api/forms/import-xlsx", {
      ...(await filePayload(testXlsxPath)),
      primaryIdentifierVariable: "participant_id"
    });
    workspaceId = imported.workspaceId;
    if (!workspaceId) throw new Error("Import did not return workspaceId.");
    if ((imported.draft?.questions || []).length < 40) {
      throw new Error(`Imported draft has too few questions: ${imported.draft?.questions?.length || 0}`);
    }

    const assetNames = (await readdir(testAssetsDir)).filter((name) => !name.startsWith("."));
    for (const assetName of assetNames) {
      const assetPath = path.join(testAssetsDir, assetName);
      await postJson(`/api/forms/${encodeURIComponent(workspaceId)}/attachments`, await filePayload(assetPath, assetName));
    }

    const attachmentInfo = await requestJson(`/api/forms/${encodeURIComponent(workspaceId)}/attachments`);
    const attachmentNames = new Set((attachmentInfo.attachments || []).map((attachment) => attachment.fileName));
    for (const required of [
      "external_choices.csv",
      "lookup.csv",
      "prompt_image.svg",
      "prompt_audio.wav",
      "prompt_video.mp4",
      "choice_yes.svg",
      "choice_no.svg",
      "choice_audio.wav",
      "choice_map.geojson"
    ]) {
      if (!attachmentNames.has(required)) throw new Error(`Missing uploaded attachment after upload: ${required}`);
    }

    await postJson(`/api/forms/${encodeURIComponent(workspaceId)}/attachments`, {
      filename: "choice_yes.svg",
      dataBase64: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><text x=\"1\" y=\"8\">Y</text></svg>").toString("base64")
    });

    const exported = await postJson("/api/forms/export", {
      workspaceId,
      form: imported.draft
    });
    if (!exported.ok) throw new Error(`Export failed: ${exported.stderr || exported.stdout || "unknown error"}`);
    if (!exported.hasXml || !exported.xmlPath) throw new Error("Export did not produce XML metadata.");

    const xml = await requestJson(`/api/forms/${encodeURIComponent(workspaceId)}/xml`);
    for (const needle of ["q_geojson_map_select", "choice_map.geojson", "jr://images/choice_yes.svg"]) {
      if (!String(xml.xml || "").includes(needle)) throw new Error(`Exported XML missing ${needle}`);
    }

    const attachment = await fetch(`${apiBase}/api/forms/${encodeURIComponent(workspaceId)}/attachments/choice_yes.svg`);
    if (!attachment.ok) throw new Error("Could not fetch uploaded choice image attachment.");

    const submitted = await postJson(`/api/forms/${encodeURIComponent(workspaceId)}/odk-submissions`, {
      instanceXml: `<data id="icph_all_question_types_test"><participant_id>SMOKE001</participant_id><q_select_one>yes</q_select_one></data>`
    });
    if (!submitted.entries?.length) throw new Error("ODK submission was not stored.");

    await deleteJson(`/api/forms/${encodeURIComponent(workspaceId)}/attachments/choice_yes.svg`);
    const afterDelete = await requestJson(`/api/forms/${encodeURIComponent(workspaceId)}/attachments`);
    if ((afterDelete.attachments || []).some((attachment) => attachment.fileName === "choice_yes.svg")) {
      throw new Error("Attachment delete did not remove choice_yes.svg.");
    }

    if (existsSync(fatalInjuryXlsxPath)) {
      const inspectedFatal = await postJson("/api/forms/inspect-xlsx", await filePayload(fatalInjuryXlsxPath));
      if (inspectedFatal.title !== "Fatal injury surveillance reporting form") {
        throw new Error(`Fatal sample inspected with wrong title: ${inspectedFatal.title}`);
      }
      if (inspectedFatal.formId !== "fatal_injury_surveillance_form") {
        throw new Error(`Fatal sample inspected with wrong form id: ${inspectedFatal.formId}`);
      }

      const importedFatal = await postJson("/api/forms/import-xlsx", {
        ...(await filePayload(fatalInjuryXlsxPath)),
        primaryIdentifierVariable: "case_id_number"
      });
      fatalWorkspaceId = importedFatal.workspaceId;
      const emptySelects = (importedFatal.draft?.questions || [])
        .filter((question) => ["select_one", "select_multiple", "rank"].includes(question.type))
        .filter((question) => !question.options?.length)
        .map((question) => question.name);
      if (emptySelects.length) {
        throw new Error(`Fatal sample imported select questions without choices: ${emptySelects.join(", ")}`);
      }
      const ageUnit = (importedFatal.draft?.questions || []).find((question) => question.name === "age_unit");
      if (!ageUnit?.constraint?.includes(". != 'months'")) {
        throw new Error("Fatal sample import did not preserve age_unit constraint.");
      }
      if (ageUnit?.constraintMessage !== "Enter age in years if older than 23 months.") {
        throw new Error("Fatal sample import did not preserve age_unit constraint_message.");
      }
      const exportedFatal = await postJson("/api/forms/export", {
        workspaceId: fatalWorkspaceId,
        form: importedFatal.draft
      });
      if (!exportedFatal.ok) {
        throw new Error(`Fatal sample export failed: ${exportedFatal.stderr || exportedFatal.stdout || "unknown error"}`);
      }
      const fatalXml = await requestJson(`/api/forms/${encodeURIComponent(fatalWorkspaceId)}/xml`);
      const fatalXmlText = String(fatalXml.xml || "");
      for (const needle of [
        "/data/group1/age_unit",
        "/data/group1/age  &lt;= 23",
        ". != 'months'",
        "Enter age in years if older than 23 months."
      ]) {
        if (!fatalXmlText.includes(needle)) {
          throw new Error(`Fatal sample exported XML missing constraint fragment: ${needle}`);
        }
      }
    }

    console.log(`Smoke pipeline passed for ${workspaceId}`);
  } finally {
    if (fatalWorkspaceId) {
      try {
        await deleteJson(`/api/forms/${encodeURIComponent(fatalWorkspaceId)}`);
      } catch (error) {
        console.error(`Cleanup failed for ${fatalWorkspaceId}: ${error.message}`);
      }
    }
    if (workspaceId) {
      try {
        await deleteJson(`/api/forms/${encodeURIComponent(workspaceId)}`);
      } catch (error) {
        console.error(`Cleanup failed for ${workspaceId}: ${error.message}`);
      }
    }
    child.kill("SIGTERM");
    await sleep(200);
    if (child.exitCode === null) child.kill("SIGKILL");
    if (process.env.ICPH_SMOKE_DEBUG_LOGS === "1") {
      console.error(logs.join(""));
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
