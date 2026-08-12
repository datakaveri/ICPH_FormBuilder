import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  ClipboardList,
  Copy,
  Download,
  ExternalLink,
  FileJson,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Forward,
  GripVertical,
  Hash,
  Home,
  Info,
  Image,
  Import,
  ListChecks,
  MapPin,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  TextCursorInput,
  Upload,
  Trash2,
  X
} from "lucide-react";
import "./styles.css";
import cdpgLogo from "./assets/cdpg-logo.png";

const DEFAULT_API_BASE = typeof window === "undefined"
  ? "http://localhost:8787"
  : `${window.location.protocol}//${window.location.hostname}:8787`;
const API_BASE = import.meta.env.VITE_FORM_BUILDER_API || DEFAULT_API_BASE;
const ADMIN_TOKEN_KEY = "icph_admin_token";
let runtimeAdminToken = "";
let runtimeAdminPassword = "";
let odkWebFormsLoader = null;

function loadOdkWebForms() {
  if (!odkWebFormsLoader) {
    odkWebFormsLoader = Promise.all([
      import("vue"),
      import("@getodk/web-forms")
    ]).then(([vue, webForms]) => ({
      createApp: vue.createApp,
      h: vue.h,
      OdkWebForm: webForms.OdkWebForm,
      POST_SUBMIT__NEW_INSTANCE: webForms.POST_SUBMIT__NEW_INSTANCE,
      webFormsPlugin: webForms.webFormsPlugin
    }));
  }
  return odkWebFormsLoader;
}

function getAdminToken() {
  if (runtimeAdminToken) return runtimeAdminToken;
  try {
    runtimeAdminToken = window.localStorage.getItem(ADMIN_TOKEN_KEY) || "";
    return runtimeAdminToken;
  } catch {
    return "";
  }
}

function saveAdminToken(token) {
  runtimeAdminToken = token || "";
  try {
    if (token) window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else window.localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {}
}

function saveAdminPassword(password) {
  runtimeAdminPassword = password || "";
}

function adminAuthHeaders() {
  const token = getAdminToken();
  return {
    ...(token ? { "x-admin-token": token } : {}),
    ...(runtimeAdminPassword ? { "x-admin-password": runtimeAdminPassword } : {})
  };
}

function normalizeAccessCodeInput(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
}

const QUESTION_TYPES = [
  { type: "text", label: "Text", icon: TextCursorInput },
  { type: "integer", label: "Integer", icon: Hash },
  { type: "decimal", label: "Decimal", icon: Hash },
  { type: "date", label: "Date", icon: Calendar },
  { type: "time", label: "Time", icon: Calendar },
  { type: "dateTime", label: "Date Time", icon: Calendar },
  { type: "select_one", label: "Single Select", icon: ChevronDown },
  { type: "select_multiple", label: "Multi Select", icon: ListChecks },
  { type: "select_one_from_file", label: "Single Select From File", icon: ChevronDown },
  { type: "select_multiple_from_file", label: "Multi Select From File", icon: ListChecks },
  { type: "rank", label: "Rank", icon: ListChecks },
  { type: "range", label: "Range", icon: Hash },
  { type: "begin_group", label: "Begin Group", icon: ClipboardList },
  { type: "end_group", label: "End Group", icon: ClipboardList },
  { type: "begin_repeat", label: "Begin Repeat", icon: ClipboardList },
  { type: "end_repeat", label: "End Repeat", icon: ClipboardList },
  { type: "geopoint", label: "Location Point", icon: MapPin },
  { type: "geotrace", label: "Location Trace", icon: MapPin },
  { type: "geoshape", label: "Location Shape", icon: MapPin },
  { type: "start-geopoint", label: "Start Location", icon: MapPin },
  { type: "image", label: "Image", icon: Image },
  { type: "audio", label: "Audio", icon: Upload },
  { type: "background-audio", label: "Background Audio", icon: Upload },
  { type: "video", label: "Video", icon: Upload },
  { type: "file", label: "File", icon: Upload },
  { type: "barcode", label: "Barcode", icon: Upload },
  { type: "audit", label: "Audit", icon: Settings },
  { type: "timer", label: "Timer", icon: Clock },
  { type: "acknowledge", label: "Acknowledge", icon: Check },
  { type: "start", label: "Start Time", icon: Calendar },
  { type: "end", label: "End Time", icon: Calendar },
  { type: "today", label: "Today", icon: Calendar },
  { type: "deviceid", label: "Device ID", icon: Settings },
  { type: "username", label: "Username", icon: Settings },
  { type: "phonenumber", label: "Phone Number", icon: Settings },
  { type: "email", label: "Email", icon: Settings },
  { type: "hidden", label: "Hidden", icon: Settings },
  { type: "note", label: "Note", icon: ClipboardList },
  { type: "calculate", label: "Calculate", icon: Settings }
];

const STRUCTURAL_TYPE_HELP = {
  begin_group: {
    title: "Begin Group opens a section",
    body: "Use this to start a visual section that contains the questions below it. Add a matching End Group after the last question in that section.",
    xls: 'ODK XLS format: "type" column is "begin group". The "name" column identifies the section; the "label" column is the section title.',
    warning: "If this section is not closed by an End Group row, XML export will fail."
  },
  end_group: {
    title: "End Group closes the nearest open group",
    body: "Use this immediately after the last question in a group. It does not collect an answer.",
    xls: 'ODK XLS format: "type" column is "end group". End rows usually do not need a question name or display label.',
    warning: "Only add this when there is an earlier Begin Group that has not already been closed."
  },
  begin_repeat: {
    title: "Begin Repeat opens a repeatable section",
    body: "Use this when the respondent may enter the same set of questions multiple times, such as one row per visit, medication, or pregnancy.",
    xls: 'ODK XLS format: "type" column is "begin repeat". The "name" column identifies the repeat block; optional Repeat Count controls how many copies are created.',
    warning: "Every Begin Repeat must have a later End Repeat. Otherwise pyxform reports: Unmatched begin_repeat."
  },
  end_repeat: {
    title: "End Repeat closes the nearest open repeat",
    body: "Use this immediately after the last question that belongs inside the repeat. It does not collect an answer.",
    xls: 'ODK XLS format: "type" column is "end repeat". End rows usually do not need a question name or display label.',
    warning: "Only add this when there is an earlier Begin Repeat that has not already been closed."
  }
};

const NON_REQUIRED_TYPES = new Set([
  "note",
  "calculate",
  "hidden",
  "begin_group",
  "end_group",
  "begin_repeat",
  "end_repeat",
  "csv-external",
  "timer",
  "start",
  "end",
  "today",
  "deviceid",
  "username",
  "phonenumber",
  "email",
  "audit",
  "start-geopoint",
  "background-audio"
]);

function workspaceRouteId(value) {
  const text = String(value || "").trim().replace(/[\\/]+$/, "");
  return text.split(/[\\/]/).filter(Boolean).pop() || text;
}

function slug(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "field";
  return /^\d/.test(cleaned) ? `q_${cleaned}` : cleaned.slice(0, 64);
}

function instanceNameForPrimaryIdentifier(primaryIdentifierVariable) {
  const variable = String(primaryIdentifierVariable || "").trim();
  if (!variable) return "";
  return `concat(\${${variable}}, ' - ', format-date-time(now(), '%Y-%m-%d %H:%M:%S'))`;
}

const TIMER_MODES = [
  {
    value: "open_submit",
    label: "Form opens -> submit",
    description: "Starts when the respondent opens the form and stops when they submit it."
  },
  {
    value: "first_input_submit",
    label: "First answer -> submit",
    description: "Starts when the respondent first types, selects, or changes any answer and stops on submit."
  },
  {
    value: "manual",
    label: "Respondent start/stop",
    description: "Shows Start and Stop buttons. If the respondent starts but forgets to stop, submission time is used as the stop time."
  }
];

function normalizeTimerConfig(config = {}) {
  const mode = TIMER_MODES.some((item) => item.value === config.mode) ? config.mode : "open_submit";
  return {
    mode,
    showToRespondent: mode === "manual" ? true : Boolean(config.showToRespondent)
  };
}

function timerFieldNames(question = {}) {
  const base = slug(question.name || question.id || "timer");
  return {
    start: `${base}_start`,
    end: `${base}_end`,
    duration: `${base}_duration_seconds`
  };
}

function timerQuestions(form = {}) {
  return (form.questions || []).filter((question) => question.type === "timer" && String(question.name || "").trim());
}

function timerGeneratedQuestions(question = {}) {
  const names = timerFieldNames(question);
  const label = question.label || question.name || "Timer";
  return [
    { id: `${question.id || names.start}:start`, type: "dateTime", name: names.start, label: `${label} start time`, generatedFromTimer: question.name || question.id },
    { id: `${question.id || names.end}:end`, type: "dateTime", name: names.end, label: `${label} end time`, generatedFromTimer: question.name || question.id },
    { id: `${question.id || names.duration}:duration`, type: "integer", name: names.duration, label: `${label} duration seconds`, generatedFromTimer: question.name || question.id }
  ];
}

function dataExportQuestions(form = {}) {
  const rows = [];
  for (const question of form.questions || []) {
    if (question.type === "timer") {
      rows.push(...timerGeneratedQuestions(question));
      continue;
    }
    rows.push(question);
  }
  return rows;
}

function newQuestion(type, index) {
  const id = crypto.randomUUID();
  const isEndStructural = type === "end_group" || type === "end_repeat";
  const structuralLabel = STRUCTURAL_TYPE_HELP[type]?.title;
  const locationDefaults = {
    geopoint: { label: "Choose a location point", appearance: "placement-map", parameters: "" },
    geotrace: { label: "Draw or capture a route", appearance: "" },
    geoshape: { label: "Draw or capture an area", appearance: "" },
    "start-geopoint": { label: "Capture start location automatically", appearance: "" }
  };
  const locationDefault = locationDefaults[type] || {};
  const base = {
    id,
    type,
    name: isEndStructural ? "" : type === "timer" ? `timer_${index + 1}` : `q${index + 1}`,
    label: isEndStructural ? "" : type === "timer" ? "Form timer" : type === "note" ? "Instruction note" : structuralLabel || locationDefault.label || "Untitled question",
    hint: "",
    required: !NON_REQUIRED_TYPES.has(type),
    relevant: "",
    appearance: locationDefault.appearance || "",
    defaultValue: "",
    constraint: "",
    constraintMessage: "",
    calculation: "",
    trigger: "",
    choiceFilter: "",
    parameters: locationDefault.parameters || "",
    repeatCount: "",
    requiredExpression: "",
    readOnlyExpression: "",
    note: "",
    image: "",
    audio: "",
    video: "",
    requiredMessage: "",
    guidanceHint: "",
    saveTo: "",
    bigImage: "",
    extraColumns: {},
    logicBuilders: {},
    timerConfig: normalizeTimerConfig(),
    readOnly: type === "calculate"
  };
  if (type === "select_one" || type === "select_multiple" || type === "rank") {
    base.listName = `q${index + 1}_choices`;
    base.options = type === "rank"
      ? [
          { id: crypto.randomUUID(), name: "item_1", label: "Item 1" },
          { id: crypto.randomUUID(), name: "item_2", label: "Item 2" },
          { id: crypto.randomUUID(), name: "item_3", label: "Item 3" }
        ]
      : [
          { id: crypto.randomUUID(), name: "0", label: "No" },
          { id: crypto.randomUUID(), name: "1", label: "Yes" }
        ];
  }
  if (type === "select_one_from_file" || type === "select_multiple_from_file") {
    base.listName = "choices.csv";
  }
  return base;
}

function questionTypeLabel(type) {
  return QUESTION_TYPES.find((item) => item.type === type)?.label || String(type || "Question");
}

function questionTypePatch(question, nextType) {
  const currentType = question?.type || "text";
  const patch = { type: nextType };
  if (NON_REQUIRED_TYPES.has(nextType)) patch.required = false;
  else if (NON_REQUIRED_TYPES.has(currentType)) patch.required = true;
  if (nextType === "calculate") {
    patch.required = false;
    patch.readOnly = true;
    patch.calculation = question?.calculation || "today()";
  } else if (currentType === "calculate") {
    patch.readOnly = false;
  }
  if (nextType === "timer") {
    patch.required = false;
    patch.readOnly = false;
    patch.name = question?.name?.startsWith("timer_") ? question.name : `timer_${Date.now().toString().slice(-5)}`;
    patch.label = question?.label && question.label !== "Untitled question" ? question.label : "Form timer";
    patch.timerConfig = normalizeTimerConfig(question?.timerConfig);
  }
  if (nextType === "geopoint") {
    patch.appearance = question?.appearance || "placement-map";
    patch.parameters = question?.parameters || "";
  } else if (nextType === "geotrace" || nextType === "geoshape") {
    patch.appearance = question?.appearance || "";
  }
  if (nextType === "start-geopoint") {
    patch.required = false;
    patch.appearance = "";
  } else if (currentType === "start-geopoint") {
    patch.readOnly = false;
  }
  if (nextType === "select_one" || nextType === "select_multiple" || nextType === "rank") {
    patch.listName = question?.listName || `${question?.name || "q"}_choices`;
    patch.options = question?.options?.length
      ? question.options
      : nextType === "rank"
        ? [
            { id: crypto.randomUUID(), name: "item_1", label: "Item 1" },
            { id: crypto.randomUUID(), name: "item_2", label: "Item 2" },
            { id: crypto.randomUUID(), name: "item_3", label: "Item 3" }
          ]
        : [
          { id: crypto.randomUUID(), name: "0", label: "No" },
          { id: crypto.randomUUID(), name: "1", label: "Yes" }
        ];
  }
  if (nextType === "select_one_from_file" || nextType === "select_multiple_from_file") {
    patch.listName = question?.listName || "choices.csv";
  }
  return patch;
}

function questionNumberLabel(form, questionId) {
  const index = (form.questions || []).findIndex((question) => question.id === questionId);
  return index >= 0 ? `question ${index + 1}` : "the selected question";
}

function defaultForm() {
  return {
    title: "Untitled ICPH Form",
    formId: "icph_form",
    version: "1",
    instanceName: "",
    defaultLanguage: "english",
    style: "",
    settingsExtraColumns: {},
    publicKey: "",
    submissionUrl: "",
    allowChoiceDuplicates: "",
    entities: [],
    questions: []
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function formBuildSnapshot(form = {}) {
  return {
    title: form.title || "",
    formId: form.formId || "",
    defaultLanguage: form.defaultLanguage || "",
    style: form.style || "",
    settingsExtraColumns: form.settingsExtraColumns || {},
    publicKey: form.publicKey || "",
    submissionUrl: form.submissionUrl || "",
    allowChoiceDuplicates: form.allowChoiceDuplicates || "",
    primaryIdentifierVariable: form.primaryIdentifierVariable || "",
    entities: form.entities || [],
    questions: form.questions || []
  };
}

function versionChangeSummary(form = {}) {
  const baseline = form.versionBaseline || null;
  if (!form.previousVersionWorkspaceId || !baseline) return [];
  const beforeQuestions = new Map((baseline.questions || []).map((question) => [question.name || question.id, question]));
  const afterQuestions = new Map((form.questions || []).map((question) => [question.name || question.id, question]));
  const changes = [];
  for (const [key, question] of afterQuestions) {
    if (!beforeQuestions.has(key)) {
      changes.push(`Added question ${question.name || key}`);
    } else if (stableStringify(question) !== stableStringify(beforeQuestions.get(key))) {
      changes.push(`Changed question ${question.name || key}`);
    }
  }
  for (const [key, question] of beforeQuestions) {
    if (!afterQuestions.has(key)) changes.push(`Removed question ${question.name || key}`);
  }
  const beforeSettings = { ...baseline };
  const afterSettings = { ...formBuildSnapshot(form) };
  delete beforeSettings.questions;
  delete afterSettings.questions;
  if (stableStringify(beforeSettings) !== stableStringify(afterSettings)) changes.unshift("Changed form settings");
  return changes;
}

function hasVersionChanges(form = {}) {
  if (!form.previousVersionWorkspaceId || !form.versionBaseline) return true;
  return stableStringify(formBuildSnapshot(form)) !== stableStringify(form.versionBaseline);
}

function comparableValue(question, value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (question?.type === "integer" || question?.type === "decimal" || question?.type === "range") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (question?.type === "date" || question?.type === "dateTime") {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }
  if (question?.type === "time") {
    const match = raw.match(/^(\d{1,2}):(\d{2})/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }
  return raw;
}

function contradictionInAndGroup(rows) {
  const byQuestion = new Map();
  for (const row of rows) {
    if (!row.sourceName || row.expectedValue === "") continue;
    const state = byQuestion.get(row.sourceName) || {
      source: row.source,
      equals: null,
      notEquals: new Set(),
      lower: null,
      upper: null,
    };
    const value = comparableValue(row.source, row.expectedValue);
    if (value === null) continue;

    if (row.operator === "is") {
      if (state.equals !== null && state.equals !== value) return `${row.sourceName} cannot equal two different values at the same time.`;
      if (state.notEquals.has(String(value))) return `${row.sourceName} cannot be both equal to and not equal to ${row.expectedValue}.`;
      state.equals = value;
    } else if (row.operator === "is_not") {
      if (state.equals !== null && state.equals === value) return `${row.sourceName} cannot be both equal to and not equal to ${row.expectedValue}.`;
      state.notEquals.add(String(value));
    } else if (row.operator === "gt" || row.operator === "gte") {
      const inclusive = row.operator === "gte";
      if (!state.lower || value > state.lower.value || (value === state.lower.value && !inclusive)) {
        state.lower = { value, inclusive };
      }
    } else if (row.operator === "lt" || row.operator === "lte") {
      const inclusive = row.operator === "lte";
      if (!state.upper || value < state.upper.value || (value === state.upper.value && !inclusive)) {
        state.upper = { value, inclusive };
      }
    }

    if (state.equals !== null) {
      if (state.lower && (state.equals < state.lower.value || (state.equals === state.lower.value && !state.lower.inclusive))) {
        return `${row.sourceName} equals a value outside its greater-than condition.`;
      }
      if (state.upper && (state.equals > state.upper.value || (state.equals === state.upper.value && !state.upper.inclusive))) {
        return `${row.sourceName} equals a value outside its less-than condition.`;
      }
    }
    if (state.lower && state.upper) {
      if (state.lower.value > state.upper.value) return `${row.sourceName} has a lower bound greater than its upper bound.`;
      if (state.lower.value === state.upper.value && (!state.lower.inclusive || !state.upper.inclusive)) {
        return `${row.sourceName} has no possible value between those bounds.`;
      }
      if (
        state.lower.value === state.upper.value &&
        state.lower.inclusive &&
        state.upper.inclusive &&
        state.notEquals.has(String(state.lower.value))
      ) {
        return `${row.sourceName} is restricted to one value and also says it cannot be that value.`;
      }
    }

    byQuestion.set(row.sourceName, state);
  }
  return "";
}

function relevantLogicIssues(form, question, label) {
  if (!question.relevant?.trim()) return [];
  const sources = priorQuestions(form, question);
  const parsed = parseRelevantExpression(question.relevant, sources);
  if (!parsed.rows.length) return [];
  const rows = parsed.rows.map((row) => ({ ...row, source: sources.find((source) => source.name === row.sourceName) }));
  const groups = [[]];
  for (const row of rows) {
    if (row.joiner === "or" && groups[groups.length - 1].length) groups.push([]);
    groups[groups.length - 1].push(row);
  }
  const contradictions = groups.map(contradictionInAndGroup).filter(Boolean);
  if (!contradictions.length) return [];
  const prefix = parsed.mode === "skip"
    ? `${label}: skip condition contains impossible logic`
    : `${label}: display condition contains impossible logic`;
  return [`${prefix}: ${contradictions[0]}`];
}

function defaultValueIssue(question = {}) {
  const value = String(question.defaultValue || "").trim();
  if (!value) return "";
  const type = question.type || "";
  if (["integer", "decimal", "range"].includes(type)) {
    if (/today\(\)|now\(\)/.test(value)) return `${question.name}: numeric questions cannot use today() or now() as a default.`;
    if (!isExpressionLike(value) && Number.isNaN(Number(value))) return `${question.name}: default must be numeric.`;
  }
  if (type === "date" && /now\(\)/.test(value)) return `${question.name}: date questions should use a date value or today(), not now().`;
  if (type === "time" && /today\(\)/.test(value)) return `${question.name}: time questions cannot use today() as a default.`;
  if ((type === "geopoint" || type === "start-geopoint") && !isExpressionLike(value)) {
    const parts = value.split(/\s+/).filter(Boolean);
    const numericParts = parts.map(Number);
    if (parts.length < 2 || numericParts.some((part) => Number.isNaN(part))) {
      return `${question.name}: location point default must use ODK geopoint format: latitude longitude altitude accuracy.`;
    }
    if (numericParts[0] < -90 || numericParts[0] > 90 || numericParts[1] < -180 || numericParts[1] > 180) {
      return `${question.name}: location point default latitude/longitude is outside valid bounds.`;
    }
  }
  return "";
}

function primaryIdentifierIssue(form = {}) {
  const selected = String(form.primaryIdentifierVariable || "").trim();
  if (!selected) return "";
  const question = primaryIdentifierCandidateRows(form).find((item) => item.name === selected || item.question?.name === selected);
  if (question) {
    if (question.inRepeat) return `Primary identifier "${selected}" is inside a repeat. Choose an identifier question outside repeat sections.`;
    if (STRUCTURAL_TYPES.has(question.type)) return `Primary identifier "${selected}" is a group/repeat structure row. Choose an answer question outside the repeat instead.`;
    if (!RESPONDENT_INPUT_TYPES.has(question.type)) return `Primary identifier "${selected}" is not a respondent answer question. Choose a named answer question instead.`;
    return "";
  }
  return `Primary identifier "${selected}" is not present in this form.`;
}

function primaryIdentifierCandidateRows(form = {}) {
  const rows = [];
  let repeatDepth = 0;
  for (const question of form.questions || []) {
    const type = String(question.type || "").trim().replace(/\s+/g, "_");
    if (type === "end_repeat") repeatDepth = Math.max(0, repeatDepth - 1);
    const name = String(question.name || "").trim();
    if (name) {
      rows.push({
        name,
        type,
        label: question.label || question.name,
        inRepeat: repeatDepth > 0,
        eligible: repeatDepth === 0 && RESPONDENT_INPUT_TYPES.has(type) && !STRUCTURAL_TYPES.has(type),
        question
      });
    }
    if (type === "begin_repeat") repeatDepth += 1;
  }
  return rows;
}

function primaryIdentifierCandidatesForForm(form = {}) {
  return primaryIdentifierCandidateRows(form)
    .filter((row) => row.eligible)
    .map(({ name, type, label }) => ({ name, type, label }));
}

function validateStructuralPairing(questions = []) {
  const issues = [];
  const stack = [];
  const openTypes = new Map([
    ["begin_group", "end_group"],
    ["begin_repeat", "end_repeat"]
  ]);
  const closeTypes = new Map([
    ["end_group", "begin_group"],
    ["end_repeat", "begin_repeat"]
  ]);

  for (const [index, question] of questions.entries()) {
    const type = question.type;
    const rowLabel = question.name || question.label || `row ${index + 1}`;
    if (openTypes.has(type)) {
      stack.push({ type, question, index });
      continue;
    }
    if (!closeTypes.has(type)) continue;
    const expectedOpen = closeTypes.get(type);
    if (!stack.length) {
      issues.push(`${questionTypeLabel(type)} at row ${index + 1} has no earlier matching ${questionTypeLabel(expectedOpen)}.`);
      continue;
    }
    const open = stack[stack.length - 1];
    if (open.type !== expectedOpen) {
      issues.push(`${questionTypeLabel(type)} at row ${index + 1} is closing the wrong block. Close ${questionTypeLabel(open.type)} '${open.question.name || open.question.label || `row ${open.index + 1}`}' first.`);
      continue;
    }
    stack.pop();
  }

  for (const open of stack.reverse()) {
    const closeType = openTypes.get(open.type);
    issues.push(`${questionTypeLabel(open.type)} '${open.question.name || open.question.label || `row ${open.index + 1}`}' at row ${open.index + 1} needs a matching ${questionTypeLabel(closeType)} later in the form.`);
  }
  return issues;
}

function validateForm(form) {
  const issues = [];
  if (!form.title?.trim()) issues.push("Form title is required.");
  if (!form.formId?.trim()) issues.push("Form ID is required.");
  if (!(form.questions || []).length) issues.push("Add at least one question before finishing Build.");
  const primaryIssue = primaryIdentifierIssue(form);
  if (primaryIssue) issues.push(primaryIssue);
  if ((form.questions || []).length && !form.primaryIdentifierVariable && !primaryIdentifierCandidatesForForm(form).length) {
    issues.push("Add at least one named respondent answer question outside repeats so it can be used as the Primary Identifier Variable before publishing. Passive rows such as note, calculate, timer, and device metadata cannot identify a respondent.");
  }
  const seenNames = new Set();
  for (const [index, question] of (form.questions || []).entries()) {
    const label = question.label || `Question ${index + 1}`;
    const isEndStructural = END_STRUCTURAL_TYPES.has(question.type);
    if (!isEndStructural && !question.name?.trim()) issues.push(`${label}: name is required.`);
    if (question.name?.trim()) {
      const normalized = slug(question.name);
      if (normalized !== question.name) issues.push(`${label}: name should be XLSForm-safe, suggested: ${normalized}.`);
      if (seenNames.has(question.name)) issues.push(`${label}: duplicate question name '${question.name}'.`);
      seenNames.add(question.name);
    }
    if (!isEndStructural && !question.label?.trim()) issues.push(`${question.name}: label is required.`);
    if (question.type === "calculate" && !question.calculation?.trim()) {
      issues.push(`${question.name}: calculate questions need a calculation expression.`);
    }
    if (question.trigger?.trim() && !question.calculation?.trim()) {
      issues.push(`${question.name}: trigger can only be used with a calculated value.`);
    }
    const defaultIssue = defaultValueIssue(question);
    if (defaultIssue) issues.push(defaultIssue);
    issues.push(...relevantLogicIssues(form, question, label));
    if (question.type === "select_one" || question.type === "select_multiple" || question.type === "rank") {
      if (!question.listName?.trim()) issues.push(`${question.name}: list name is required.`);
      const options = question.options || [];
      if (options.length === 0) issues.push(`${question.name}: add at least one option.`);
      const hasChoiceMedia = options.some((option) =>
        Boolean(
          String(option.image || "").trim() ||
          String(option.audio || "").trim() ||
          String(option.video || "").trim() ||
          String(option.bigImage || option["big-image"] || "").trim()
        )
      );
      const appearanceTokens = String(question.appearance || "").toLowerCase().split(/\s+/).filter(Boolean);
      if (hasChoiceMedia && appearanceTokens.some((token) => token === "minimal" || token === "autocomplete")) {
        issues.push(`${question.name}: option media will not render in dropdown/autocomplete appearance. Remove minimal/autocomplete appearance to show image answer options.`);
      }
      const seenOptions = new Set();
      for (const option of options) {
        if (!String(option.name || "").trim() || !String(option.label || "").trim()) {
          issues.push(`${question.name}: each option needs a value and label.`);
        }
        if (String(option.geometry || "").trim().toLowerCase().endsWith(".geojson")) {
          issues.push(`${question.name}: choices-sheet geometry expects ODK geometry text, not a GeoJSON filename. Use select_one_from_file with the GeoJSON file and map appearance instead.`);
        }
        if (seenOptions.has(option.name)) issues.push(`${question.name}: duplicate option value '${option.name}'.`);
        seenOptions.add(option.name);
      }
    }
  }
  issues.push(...validateStructuralPairing(form.questions || []));
  return issues;
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function decimalDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return NaN;
  return date.getTime() / 86400000;
}

function selected(value, choice) {
  return String(value || "").split(/\s+/).filter(Boolean).includes(String(choice));
}

function xlsDate(value) {
  return String(value || "").replace(/^['"]|['"]$/g, "");
}

function transformXlsExpression(expression) {
  let js = String(expression || "").trim();
  js = js.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  js = js.replace(/\bdecimal-date-time\s*\(/g, "decimalDateTime(");
  js = js.replace(/\bdate\s*\(/g, "xlsDate(");
  js = js.replace(/\btoday\s*\(/g, "today(");
  js = js.replace(/\bint\s*\(/g, "Math.trunc(");
  js = js.replace(/\bif\s*\(/g, "ifFn(");
  js = js.replace(/\$\{([^}]+)\}/g, (_, name) => `get(${JSON.stringify(name)})`);
  js = js.replace(/\/data(?:\/[A-Za-z0-9_-]+)*\/([A-Za-z0-9_:-]+)/g, (_, name) => `get(${JSON.stringify(name)})`);
  js = js.replace(/\btrue\s*\(\s*\)/gi, "true");
  js = js.replace(/\bfalse\s*\(\s*\)/gi, "false");
  js = js.replace(/(^|[^\w$])\.(?=\s|[=!<>+\-*/)]|$)/g, "$1current");
  js = js.replace(/\bdiv\b/g, "/");
  js = js.replace(/\band\b/gi, "&&");
  js = js.replace(/\bor\b/gi, "||");
  js = js.replace(/\bnot\s*\(/gi, "!(");
  js = js.replace(/(?<![!<>=])=(?!=)/g, "==");
  return js;
}

function evaluateXlsExpression(expression, answers = {}, currentValue = "") {
  const raw = String(expression || "").trim();
  if (!raw) return true;
  const js = transformXlsExpression(raw);
  const get = (name) => answers[name] ?? "";
  const ifFn = (condition, whenTrue, whenFalse) => (condition ? whenTrue : whenFalse);
  try {
    return Function("get", "current", "selected", "decimalDateTime", "xlsDate", "today", "ifFn", `return (${js});`)(
      get,
      currentValue,
      selected,
      decimalDateTime,
      xlsDate,
      todayString,
      ifFn
    );
  } catch {
    return false;
  }
}

function isQuestionVisible(question, answers) {
  if (!question.relevant?.trim()) return true;
  return Boolean(evaluateXlsExpression(question.relevant, answers));
}

function computeCalculatedAnswers(form, answers) {
  let next = { ...answers };
  for (let pass = 0; pass < 6; pass += 1) {
    let changed = false;
    for (const question of form.questions || []) {
      if (!question.calculation?.trim()) continue;
      const value = evaluateXlsExpression(question.calculation, next);
      const normalized = value === null || value === undefined || Number.isNaN(value) ? "" : String(value);
      if (next[question.name] !== normalized) {
        next = { ...next, [question.name]: normalized };
        changed = true;
      }
    }
    if (!changed) break;
  }
  return next;
}

function visibleQuestions(form, answers) {
  const calculated = computeCalculatedAnswers(form, answers);
  return (form.questions || []).filter((question) => (
    !STRUCTURAL_TYPES.has(question.type) &&
    !NON_DISPLAY_TYPES.has(question.type) &&
    isQuestionVisible(question, calculated)
  ));
}

function validateAnswers(form, answers) {
  const calculated = computeCalculatedAnswers(form, answers);
  const errors = [];
  for (const question of visibleQuestions(form, calculated)) {
    if (question.type === "note" || question.type === "calculate") continue;
    const value = calculated[question.name] ?? "";
    const requiredByExpression = question.requiredExpression?.trim()
      ? Boolean(evaluateXlsExpression(question.requiredExpression, calculated, value))
      : false;
    if ((question.required || requiredByExpression) && String(value).trim() === "") {
      errors.push(`${question.label || question.name} is required.`);
    }
    if (String(value).trim() && question.constraint?.trim()) {
      const ok = Boolean(evaluateXlsExpression(question.constraint, calculated, value));
      if (!ok) errors.push(question.constraintMessage || `${question.label || question.name} does not satisfy its constraint.`);
    }
  }
  return { answers: calculated, errors };
}

async function requestJson(path, options = {}) {
  const headers = {
    ...adminAuthHeaders(),
    ...(options.headers || {})
  };
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, error: text || response.statusText || "Request failed" };
  }
  if (!response.ok || data.ok === false) {
    const message = data.error || data.stderr || "Request failed";
    const error = new Error(response.status === 404 ? `${message}: ${path}` : message);
    error.status = response.status;
    error.payload = data;
    error.path = path;
    throw error;
  }
  return data;
}

function postJson(path, payload) {
  return requestJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

function deleteJson(path) {
  return requestJson(path, { method: "DELETE" });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function attachmentUrl(workspaceId, href) {
  const fileName = String(href || "").split(/[\\/]/).filter(Boolean).pop() || "";
  return `${API_BASE}/api/forms/${encodeURIComponent(workspaceRouteId(workspaceId))}/attachments/${encodeURIComponent(fileName)}`;
}

function resourceFileName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.split(/[\\/]/).filter(Boolean).pop() || "";
}

function resourceFileKey(value) {
  return resourceFileName(value).toLowerCase();
}

function looksLikeResourceFile(value) {
  return /\.(csv|tsv|geojson|json|png|jpe?g|gif|svg|webp|mp3|wav|ogg|m4a|mp4|webm|pdf)$/i.test(String(value || "").trim());
}

function looksLikeResourceColumn(column, value) {
  if (!looksLikeResourceFile(value)) return false;
  const key = String(column || "").toLowerCase().replace(/\s+/g, "");
  return (
    key.includes("image") ||
    key.includes("audio") ||
    key.includes("video") ||
    key.includes("media") ||
    key.includes("file") ||
    key.includes("geometry") ||
    key.includes("geojson") ||
    key === "big-image" ||
    key === "bigimage"
  );
}

function formResourceRequirements(form, attachmentNames = []) {
  const uploaded = new Set(attachmentNames.map(resourceFileKey).filter(Boolean));
  const requirements = [];
  const addRequirement = (question, details) => {
    const fileName = resourceFileName(details.fileName);
    if (!fileName) return;
    const fileKey = resourceFileKey(fileName);
    requirements.push({
      id: `${question.id || question.name}:${details.scope || "question"}:${details.column}:${details.optionId || ""}:${fileName}`,
      questionId: question.id,
      questionName: question.name,
      questionLabel: question.label || question.name,
      fileName,
      fileKey,
      column: details.column,
      scope: details.scope || "question",
      optionId: details.optionId || "",
      optionLabel: details.optionLabel || "",
      requiredBecause: details.requiredBecause || "",
      uploaded: uploaded.has(fileKey)
    });
  };

  for (const question of form.questions || []) {
    if (question.type === "select_one_from_file" || question.type === "select_multiple_from_file") {
      addRequirement(question, {
        column: "type",
        fileName: question.listName,
        requiredBecause: `${question.type} uses an external choices file`
      });
    }
    for (const column of ["image", "audio", "video", "bigImage"]) {
      if (question[column]) {
        addRequirement(question, {
          column: column === "bigImage" ? "big-image" : column,
          fileName: question[column],
          requiredBecause: `Question ${column === "bigImage" ? "big-image" : column} media`
        });
      }
    }
    for (const [column, value] of Object.entries(question.extraColumns || {})) {
      if (looksLikeResourceColumn(column, value)) {
        addRequirement(question, {
          column,
          fileName: value,
          requiredBecause: `Question ${column} resource`
        });
      }
    }
    for (const option of question.options || []) {
      for (const column of ["image", "audio", "video", "bigImage"]) {
        if (option[column]) {
          addRequirement(question, {
            scope: "choice",
            optionId: option.id || option.name,
            optionLabel: option.label || option.name,
            column: column === "bigImage" ? "big-image" : column,
            fileName: option[column],
            requiredBecause: `Choice ${column === "bigImage" ? "big-image" : column} media`
          });
        }
      }
      if (looksLikeResourceFile(option.geometry)) {
        addRequirement(question, {
          scope: "choice",
          optionId: option.id || option.name,
          optionLabel: option.label || option.name,
          column: "geometry",
          fileName: option.geometry,
          requiredBecause: "Choice map geometry file"
        });
      }
      for (const [column, value] of Object.entries(option.extraColumns || {})) {
        if (looksLikeResourceColumn(column, value)) {
          addRequirement(question, {
            scope: "choice",
            optionId: option.id || option.name,
            optionLabel: option.label || option.name,
            column,
            fileName: value,
            requiredBecause: `Choice ${column} resource`
          });
        }
      }
    }
  }
  return requirements;
}

function booleanColumnTrue(value) {
  if (typeof value === "boolean") return value;
  return /^(yes|true|1)$/i.test(String(value || "").trim());
}

function booleanColumnExpression(value) {
  if (typeof value === "boolean") return "";
  const text = String(value || "").trim();
  if (!text || /^(yes|true|1|no|false|0)$/i.test(text)) return "";
  return text;
}

function normalizeFormDraft(draft) {
  const base = defaultForm();
  const source = draft && typeof draft === "object" ? draft : {};
  const questions = Array.isArray(source.questions) ? source.questions : [];
  return {
    ...base,
    ...source,
    questions: questions.map((question, index) => ({
      id: question.id || `question_${index + 1}_${slug(question.name || question.label || "field")}`,
      type: question.type || "text",
      name: question.name || `q${index + 1}`,
      label: question.label || question.name || `Question ${index + 1}`,
      hint: question.hint || "",
      required: booleanColumnTrue(question.required),
      relevant: question.relevant || "",
      appearance: question.appearance || "",
      defaultValue: question.defaultValue || "",
      constraint: question.constraint || "",
      constraintMessage: question.constraintMessage || "",
      calculation: question.calculation || "",
      trigger: question.trigger || "",
      choiceFilter: question.choiceFilter || question.choice_filter || "",
      parameters: question.parameters || "",
      repeatCount: question.repeatCount || question.repeat_count || "",
      requiredExpression: question.requiredExpression || question.required_expression || booleanColumnExpression(question.required),
      readOnlyExpression: question.readOnlyExpression || question.read_only_expression || booleanColumnExpression(question.readOnly ?? question.read_only),
      note: question.note || "",
      image: question.image || "",
      audio: question.audio || question["audio "] || "",
      video: question.video || "",
      requiredMessage: question.requiredMessage || question.required_message || "",
      guidanceHint: question.guidanceHint || question.guidance_hint || "",
      saveTo: question.saveTo || question.save_to || "",
      bigImage: question.bigImage || question["big-image"] || "",
      extraColumns: question.extraColumns && typeof question.extraColumns === "object" ? question.extraColumns : {},
      logicBuilders: question.logicBuilders && typeof question.logicBuilders === "object" ? question.logicBuilders : {},
      timerConfig: normalizeTimerConfig(question.timerConfig),
      readOnly: booleanColumnTrue(question.readOnly),
      listName: question.listName || "",
      options: Array.isArray(question.options)
        ? question.options.map((option, optionIndex) => ({
            id: option.id || `${question.name || `q${index + 1}`}_option_${optionIndex + 1}`,
            name: String(option.name ?? option.value ?? ""),
            label: String(option.label ?? option.name ?? option.value ?? ""),
            image: String(option.image || ""),
            audio: String(option.audio || ""),
            video: String(option.video || ""),
            bigImage: String(option.bigImage || option["big-image"] || ""),
            geometry: String(option.geometry || ""),
            extraColumns: option.extraColumns && typeof option.extraColumns === "object" ? option.extraColumns : {}
          }))
        : []
    }))
  };
}

function xmlLocalName(node) {
  return node?.localName || String(node?.nodeName || "").replace(/^.*:/, "");
}

function directChild(element, name) {
  return [...(element?.children || [])].find((child) => xmlLocalName(child) === name) || null;
}

function directChildren(element, name) {
  return [...(element?.children || [])].filter((child) => xmlLocalName(child) === name);
}

function childText(element, name) {
  return directChild(element, name)?.textContent?.trim() || "";
}

function attrBySuffix(element, suffix) {
  for (const attr of [...(element?.attributes || [])]) {
    if (attr.name === suffix || attr.name.endsWith(`:${suffix}`)) return attr.value;
  }
  return "";
}

function leafNameFromPath(pathValue) {
  const parts = String(pathValue || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function isTrueExpression(value) {
  return /true\s*\(\s*\)|^true$/i.test(String(value || "").trim());
}

function xformInputType(bindType) {
  const type = String(bindType || "").toLowerCase();
  if (type === "int" || type === "integer") return "integer";
  if (type === "decimal" || type === "float" || type === "double") return "decimal";
  if (type === "date") return "date";
  if (type === "time") return "time";
  if (type === "datetime" || type === "datetime-local" || type === "dateTime".toLowerCase()) return "dateTime";
  if (type === "geopoint") return "geopoint";
  if (type === "geotrace") return "geotrace";
  if (type === "geoshape") return "geoshape";
  if (type === "binary") return "file";
  return "text";
}

function parseXFormChoices(control, choiceInstances) {
  const itemset = directChild(control, "itemset");
  if (itemset) {
    const nodeset = itemset.getAttribute("nodeset") || "";
    const match = nodeset.match(/instance\(['"]([^'"]+)['"]\)/);
    if (match) return choiceInstances.get(match[1]) || [];
  }
  return directChildren(control, "item").map((item, index) => ({
    id: `xml_choice_${index + 1}`,
    name: childText(item, "value"),
    label: childText(item, "label")
  }));
}

function parseXFormXml(xmlText, fallbackDraft = {}) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Could not parse published XForm XML.");

  const all = [...doc.getElementsByTagName("*")];
  const title = all.find((node) => xmlLocalName(node) === "title")?.textContent?.trim() || fallbackDraft.title || "Published Form";
  const instances = all.filter((node) => xmlLocalName(node) === "instance");
  const mainInstance = instances.find((node) => !node.getAttribute("id")) || instances[0] || null;
  const dataElement = [...(mainInstance?.children || [])][0] || null;
  const formId = dataElement?.getAttribute("id") || fallbackDraft.formId || "published_form";
  const version = dataElement?.getAttribute("version") || fallbackDraft.version || "1";

  const defaults = new Map();
  if (dataElement) {
    for (const child of [...dataElement.children].filter((node) => xmlLocalName(node) !== "meta")) {
      defaults.set(xmlLocalName(child), child.textContent?.trim() || "");
    }
  }

  const choiceInstances = new Map();
  for (const instance of instances.filter((node) => node.getAttribute("id"))) {
    const id = instance.getAttribute("id");
    const root = [...instance.children][0];
    const choices = directChildren(root, "item").map((item, index) => ({
      id: `${id}_${index + 1}`,
      name: childText(item, "name") || childText(item, "value"),
      label: childText(item, "label") || childText(item, "name") || childText(item, "value")
    }));
    choiceInstances.set(id, choices);
  }

  const binds = new Map();
  for (const bind of all.filter((node) => xmlLocalName(node) === "bind")) {
    const name = leafNameFromPath(bind.getAttribute("nodeset"));
    if (!name) continue;
    binds.set(name, {
      type: bind.getAttribute("type") || "",
      required: bind.getAttribute("required") || "",
      relevant: bind.getAttribute("relevant") || "",
      constraint: bind.getAttribute("constraint") || "",
      constraintMessage: attrBySuffix(bind, "constraintMsg"),
      calculation: bind.getAttribute("calculate") || "",
      readOnly: bind.getAttribute("readonly") || ""
    });
  }

  const body = all.find((node) => xmlLocalName(node) === "body") || doc.documentElement;
  const controlNames = new Set(["input", "select1", "select", "upload", "trigger"]);
  const controls = [...body.getElementsByTagName("*")].filter((node) => controlNames.has(xmlLocalName(node)));
  const questions = controls.map((control, index) => {
    const name = leafNameFromPath(control.getAttribute("ref") || control.getAttribute("nodeset")) || `q${index + 1}`;
    const bind = binds.get(name) || {};
    const requiredExpression = booleanColumnExpression(bind.required);
    const readOnlyExpression = booleanColumnExpression(bind.readOnly);
    const controlType = xmlLocalName(control);
    const type = controlType === "select1"
      ? "select_one"
      : controlType === "select"
        ? "select_multiple"
        : controlType === "upload"
          ? "file"
          : controlType === "trigger"
            ? "acknowledge"
            : xformInputType(bind.type);
    const options = type === "select_one" || type === "select_multiple" ? parseXFormChoices(control, choiceInstances) : [];
    return {
      id: `xml_${index + 1}_${name}`,
      type,
      name,
      label: childText(control, "label") || name,
      hint: childText(control, "hint"),
      required: isTrueExpression(bind.required),
      requiredExpression,
      relevant: bind.relevant || "",
      appearance: control.getAttribute("appearance") || "",
      defaultValue: defaults.get(name) || "",
      constraint: bind.constraint || "",
      constraintMessage: bind.constraintMessage || "",
      calculation: bind.calculation || "",
      readOnlyExpression,
      readOnly: isTrueExpression(bind.readOnly),
      listName: "",
      options
    };
  });

  const hiddenTimerQuestions = (fallbackDraft.questions || []).filter((question) => question.type === "timer");

  return normalizeFormDraft({
    ...fallbackDraft,
    title,
    formId,
    version,
    questions: [...questions, ...hiddenTimerQuestions],
    source: "published_xml"
  });
}

function InfoButton({ label, children }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info-wrap">
      <button
        type="button"
        className="info-button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <Info size={14} />
      </button>
      {open ? <span className="info-popover" role="note">{children}</span> : null}
    </span>
  );
}

const STRUCTURAL_TYPES = new Set(["begin_group", "end_group", "begin_repeat", "end_repeat"]);
const END_STRUCTURAL_TYPES = new Set(["end_group", "end_repeat"]);
const LOCATION_TYPES = new Set(["geopoint", "geotrace", "geoshape", "start-geopoint"]);
const DRAWN_LOCATION_TYPES = new Set(["geopoint", "geotrace", "geoshape"]);
const PASSIVE_TYPES = new Set(["note", "calculate", "csv-external", "timer", "audit", "start", "end", "today", "deviceid", "username", "phonenumber", "email"]);
const RESPONDENT_INPUT_TYPES = new Set([
  "text",
  "integer",
  "decimal",
  "date",
  "time",
  "dateTime",
  "select_one",
  "select_multiple",
  "select_one_from_file",
  "select_multiple_from_file",
  "rank",
  "range",
  "geopoint",
  "geotrace",
  "geoshape",
  "image",
  "audio",
  "video",
  "file",
  "barcode",
  "acknowledge"
]);
const MEDIA_PROMPT_EXCLUDED_TYPES = new Set(["end_group", "end_repeat", "calculate", "hidden", "csv-external", "timer", "audit", "start", "end", "today", "deviceid", "username", "phonenumber", "email"]);
const PARAMETER_TYPES = new Set(["range", "image", "audio", "video", "background-audio", "file", "barcode"]);
const CALCULATION_TYPES = new Set(["text", "integer", "decimal", "date", "time", "dateTime", "range", "hidden", "calculate"]);
const NON_DISPLAY_TYPES = new Set(["calculate", "hidden", "csv-external", "timer", "audit", "start", "end", "today", "deviceid", "username", "phonenumber", "email", "background-audio"]);

function hasColumnValue(question, ...fields) {
  return fields.some((field) => String(question?.[field] || "").trim());
}

function canRequireQuestion(question) {
  return !NON_REQUIRED_TYPES.has(question.type) && RESPONDENT_INPUT_TYPES.has(question.type);
}

function canValidateAnswer(question) {
  return RESPONDENT_INPUT_TYPES.has(question.type) && question.type !== "start-geopoint";
}

function canDefaultQuestion(question) {
  return !STRUCTURAL_TYPES.has(question.type) && !["note", "calculate", "csv-external", "timer", "audit", "background-audio"].includes(question.type);
}

function canUseTrigger(question) {
  return canUseCalculation(question) || hasColumnValue(question, "trigger");
}

function canUseAppearance(question) {
  return !["end_group", "end_repeat", "calculate", "hidden", "csv-external", "timer", "audit", "start", "end", "today", "deviceid", "username", "phonenumber", "email"].includes(question.type);
}

function canUseParameters(question) {
  return PARAMETER_TYPES.has(question.type);
}

function canUseCalculation(question) {
  return CALCULATION_TYPES.has(question.type) || hasColumnValue(question, "calculation");
}

function canUsePromptMedia(question) {
  return !MEDIA_PROMPT_EXCLUDED_TYPES.has(question.type);
}

function canUseGuidanceHint(question) {
  return canUsePromptMedia(question);
}

function columnInfoText(column) {
  const info = {
    name: "The short variable name saved in the XLSForm. Example: patient_age.",
    label: "The question text the respondent sees. Example: What is the patient's age?",
    hint: "Small helper text under the question. Example: Enter age in completed years.",
    required: "Makes an answer mandatory. Example: require age before the form can be submitted.",
    relevant: "Controls whether this question is shown. Example: show pregnancy questions only when sex is Female.",
    constraint: "Checks whether the answer is allowed. Example: age must be greater than or equal to 0.",
    constraint_message: "The message shown when the answer fails the condition. Example: Age cannot be negative.",
    required_message: "The message shown when a required question is left blank. Example: Please enter the patient ID.",
    default: "Pre-fills an answer when the form entry is first created. Example: default today's date for a visit date question.",
    appearance: "Changes how a question looks. Example: autocomplete makes a long select list searchable.",
    parameters: "Extra settings for certain question widgets. Example: range can use start=0 end=100 step=5.",
    trigger: "Recalculates this row's calculated value when another visible answer changes. Example: update diagnosis age when current age changes.",
    choice_filter: "Filters a select list using an earlier answer. Example: show only facilities from the selected district.",
    repeat_count: "Sets how many repeat groups are created. Example: repeat child details once for each child count.",
    note: "Designer note carried in the XLSForm survey sheet. This is useful for local review notes and imported templates.",
    guidance_hint: "Extra guidance for the question. Example: explain how to measure waist circumference.",
    save_to: "Usually leave this blank. It is not the question name. Use it only when an ODK Entity record should copy this answer into one of its fields, such as saving facility_name into the Facility entity field called name.",
    image: "A media file shown with the question label. Example: wound_diagram.png.",
    "big-image": "A larger image shown with the question label. Example: body_map.png.",
    audio: "An audio prompt shown with the question. Example: consent_audio.mp3.",
    video: "A video prompt shown with the question. Example: inhaler_demo.mp4.",
    calculation: "Computes or prefills a value. Add a trigger only when this calculated value should update after another answer changes."
  };
  return info[column] || "This controls the corresponding XLSForm column.";
}

function settingInfoText(setting) {
  const info = {
    form_title: {
      text: "The human-readable form name shown to users. Example: Baseline visit form.",
      column: "form_title"
    },
    form_id: {
      text: "The stable technical ID for the form. Keep it short and unique. Example: baseline_visit.",
      column: "form_id",
      note: "It will be made XLS-safe during export."
    },
    version: {
      text: "The form version used by ODK to tell one published revision from another. Example: 2026-07-23-1.",
      column: "version"
    },
    instance_name: {
      text: "The label shown for each submitted entry. We usually set this from the primary identifier plus submission time. Example: ${patient_id} - 2026-07-23 10:30:00.",
      column: "instance_name"
    },
    style: {
      text: "Optional ODK display style for the whole form. Most forms can leave this blank unless a target ODK renderer expects a specific style.",
      column: "style"
    },
    submission_url: {
      text: "Optional server endpoint where submissions are sent. Leave blank when this app or ODK Central handles publishing.",
      column: "submission_url"
    }
  };
  const item = info[setting];
  if (!item) return "This controls the corresponding XLSForm settings sheet value.";
  return (
    <>
      <span>{item.text}</span>
      <span>ODK XLS settings sheet: "{item.column}" column.{item.note ? ` ${item.note}` : ""}</span>
    </>
  );
}

const VOCABULARY_OPTIONS = [
  { id: "snomed", label: "SNOMED CT", codeLabel: "SNOMED CT" },
  { id: "loinc", label: "LOINC", codeLabel: "LOINC" },
  { id: "icd10", label: "ICD-10", codeLabel: "ICD-10" },
  { id: "rxnorm", label: "RxNorm", codeLabel: "RxNorm" }
];

function vocabularyKey(value) {
  const text = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (text.includes("loinc")) return "loinc";
  if (text.includes("rxnorm") || text.includes("rxcui")) return "rxnorm";
  if (text.includes("icd")) return "icd10";
  return "snomed";
}

function vocabularyOption(value) {
  const key = vocabularyKey(value);
  return VOCABULARY_OPTIONS.find((item) => item.id === key) || VOCABULARY_OPTIONS[0];
}

function approvedMappingKey(mapping = {}) {
  return `${vocabularyKey(mapping.vocabulary || mapping.vocabularyLabel || mapping.terminology)}:${String(mapping.code || "").trim()}`;
}

function normalizeApprovedMapping(mapping = {}) {
  const code = String(mapping.code || "").trim();
  if (!code) return null;
  const option = vocabularyOption(mapping.vocabulary || mapping.vocabularyLabel || mapping.terminology);
  const display = String(mapping.display || mapping.preferredTerm || mapping.term || mapping.fsn || code);
  return {
    vocabulary: option.id,
    vocabularyLabel: mapping.vocabularyLabel || option.label,
    terminology: mapping.terminology || mapping.vocabularyLabel || option.label,
    code,
    display,
    term: String(mapping.term || mapping.preferredTerm || display),
    fsn: String(mapping.fsn || mapping.display || display),
    systemUri: mapping.systemUri || mapping.system_uri || "",
    approvedAt: mapping.approvedAt || new Date().toISOString(),
    approvedVia: mapping.approvedVia || "ui_review"
  };
}

function approvedMappingsForEntity(entity = {}) {
  const source = entity || {};
  if (source.validationStatus === "auto_approved") return [];
  return (Array.isArray(source.approvedMappings) ? source.approvedMappings : [])
    .map(normalizeApprovedMapping)
    .filter(Boolean)
    .filter((mapping) => mapping.approvedVia !== "automatic_high_confidence_brute_search");
}

function candidateMappingsForEntity(entity = {}) {
  const approvedKeys = new Set(approvedMappingsForEntity(entity).map(approvedMappingKey));
  const seen = new Set();
  return (Array.isArray(entity?.candidateMappings) ? entity.candidateMappings : [])
    .map((mapping) => {
      const normalized = normalizeApprovedMapping(mapping);
      return normalized ? {
        ...normalized,
        confidence: mapping.confidence || "",
        matchKind: mapping.matchKind || "",
        score: mapping.score ?? ""
      } : null;
    })
    .filter((mapping) => {
      if (!mapping) return false;
      const key = approvedMappingKey(mapping);
      if (approvedKeys.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function entityReviewComplete(entity = {}) {
  if (entity.validationStatus === "auto_approved") return false;
  return Boolean(
    entity.validationStatus === "unmapped_confirmed" ||
    ["selected", "replaced"].includes(entity.validationStatus) ||
    approvedMappingsForEntity(entity).length > 0
  );
}

function terminologyReviewStats(terminology = {}) {
  const questions = Array.isArray(terminology.questions) ? terminology.questions : [];
  const entities = questions.flatMap((question) => Array.isArray(question.entities) ? question.entities : []);
  const reviewed = entities.filter(entityReviewComplete).length;
  return {
    total: entities.length,
    reviewed,
    pending: Math.max(0, entities.length - reviewed),
    complete: terminology.status === "complete" && entities.length === reviewed
  };
}

function terminologyPublishIssue(terminology = {}) {
  if (terminology.status === "skipped_unmapped") return "";
  if (terminology.status === "running") return "Terminology extraction is still running. Review the vocabulary results before publishing.";
  if (terminology.status !== "complete") return "Run Terminology before publishing, then approve every vocabulary item.";
  const stats = terminologyReviewStats(terminology);
  if (stats.pending > 0) return `Review ${stats.pending} vocabulary item${stats.pending === 1 ? "" : "s"} before publishing.`;
  return "";
}

function terminologyWords(value) {
  return [...new Set(String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [])]
    .filter((word) => word && word !== "s");
}

function displayFormText(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if (Array.isArray(value)) return value.map(displayFormText).filter(Boolean).join(" ");
    for (const key of ["english", "en", "default", "label"]) {
      if (value[key]) return displayFormText(value[key]);
    }
    return Object.values(value).map(displayFormText).filter(Boolean).join(" ");
  }
  return String(value || "").replace(/\s+/g, " ").trim();
}

function downloadBlob(blob, fileName) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function safeDownloadName(value, fallback = "download") {
  return String(value || fallback)
    .replace(/[\\/]+/g, "_")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || fallback;
}

function csvValue(value) {
  if (Array.isArray(value)) return value.map(csvValue).join(" | ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return value ?? "";
}

function csvEscape(value) {
  const text = String(csvValue(value));
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function entryCsvQuestions(form = {}) {
  const seen = new Set();
  return dataExportQuestions(form)
    .filter((question) => {
      const name = String(question?.name || "").trim();
      if (!name || seen.has(name)) return false;
      if (STRUCTURAL_TYPES.has(question.type)) return false;
      if (["note", "csv-external", "timer", "audit", "background-audio"].includes(question.type)) return false;
      seen.add(name);
      return true;
    });
}

function entriesToCsv(form, entries) {
  const questions = entryCsvQuestions(form);
  const headers = questions.map((question) => String(question.name || "").trim());
  const rows = [headers.map(csvEscape).join(",")];
  for (const entry of entries) {
    const answers = computeCalculatedAnswers(form, entry.answers || {});
    rows.push(headers.map((header) => csvEscape(answers[header])).join(","));
  }
  return rows.join("\n") + "\n";
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateParts(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function binaryHeader(length, writer) {
  const buffer = new Uint8Array(length);
  const view = new DataView(buffer.buffer);
  writer(view);
  return buffer;
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function zipBlob(files) {
  const encoder = new TextEncoder();
  const { time, date } = dosDateParts();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(safeDownloadName(file.name, "bundle.json"));
    const dataBytes = encoder.encode(file.text || "");
    const checksum = crc32(dataBytes);
    const localHeader = binaryHeader(30, (view) => {
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, time, true);
      view.setUint16(12, date, true);
      view.setUint32(14, checksum, true);
      view.setUint32(18, dataBytes.length, true);
      view.setUint32(22, dataBytes.length, true);
      view.setUint16(26, nameBytes.length, true);
      view.setUint16(28, 0, true);
    });
    localParts.push(localHeader, nameBytes, dataBytes);

    const centralHeader = binaryHeader(46, (view) => {
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, time, true);
      view.setUint16(14, date, true);
      view.setUint32(16, checksum, true);
      view.setUint32(20, dataBytes.length, true);
      view.setUint32(24, dataBytes.length, true);
      view.setUint16(28, nameBytes.length, true);
      view.setUint16(30, 0, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(42, offset, true);
    });
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endHeader = binaryHeader(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, files.length, true);
    view.setUint16(10, files.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, offset, true);
    view.setUint16(20, 0, true);
  });

  return new Blob([concatBytes([...localParts, ...centralParts, endHeader])], { type: "application/zip" });
}

function formQuestionForTerminologyQuestion(question = {}, form = {}) {
  const formQuestions = Array.isArray(form.questions) ? form.questions : [];
  const questionId = String(question.id || "");
  const questionName = String(question.name || "");
  return formQuestions.find((item) => {
    return String(item.id || "") === questionId || String(item.name || "") === questionName;
  }) || question;
}

function manualEntityQuestionDetails(question = {}, form = {}) {
  const source = formQuestionForTerminologyQuestion(question, form);
  const options = Array.isArray(source.options) ? source.options : [];
  const choices = options
    .map((option) => {
      const label = displayFormText(option.label);
      const name = displayFormText(option.name);
      if (label && name && label !== name) return `${label} (${name})`;
      return label || name;
    })
    .filter(Boolean);
  return [
    { label: "Question", value: displayFormText(source.label || question.label) },
    { label: "Hint", value: displayFormText(source.hint || question.hint) },
    { label: "Guidance Hint", value: displayFormText(source.guidanceHint || source.guidance_hint || question.guidanceHint || question.guidance_hint) },
    { label: "Question name", value: displayFormText(source.name || question.name) },
    { label: "Options/Choices", value: choices.join("; ") }
  ].filter((item) => item.value);
}

function terminologyQuestionText(question = {}, form = {}) {
  return manualEntityQuestionDetails(question, form)
    .filter((item) => item.label !== "Question name")
    .map((item) => item.value)
    .join(" ");
}

function unmatchedManualEntityWords(entityText, question = {}, form = {}) {
  const sourceWords = new Set(terminologyWords(terminologyQuestionText(question, form)));
  return terminologyWords(entityText).filter((word) => !sourceWords.has(word));
}

function manualEntityKey(value) {
  return terminologyWords(value).join(" ");
}

function isStructuralQuestion(question = {}) {
  const type = String(question.type || "").trim().replace(/\s+/g, "_");
  return STRUCTURAL_TYPES.has(type);
}

function entitySourceLabel(entity = {}) {
  return String(entity.sourceLabel || entity.source_label || entity.raw?.source_label || entity.raw?.source_component || "").trim();
}

function entitySourceText(entity = {}) {
  return String(entity.sourceText || entity.source_text || entity.raw?.source_text || "").trim();
}

const ENTITY_SOURCE_LEGEND = [
  { key: "label", label: "Question", emoji: "❓" },
  { key: "hint", label: "Question hint", emoji: "💡" },
  { key: "guidance_hint", label: "Guidance hint", emoji: "🧭" },
  { key: "option", label: "Option/choice", emoji: "☑️" },
  { key: "manual", label: "Added by admin", emoji: "✍️" },
  { key: "unknown", label: "Source not recorded", emoji: "•" }
];

function entitySourceComponent(entity = {}) {
  return String(entity.sourceComponent || entity.source_component || entity.raw?.source_component || "").trim();
}

function entitySourceLegendItem(entity = {}) {
  const component = entitySourceComponent(entity);
  const label = entitySourceLabel(entity);
  return ENTITY_SOURCE_LEGEND.find((item) => item.key === component)
    || ENTITY_SOURCE_LEGEND.find((item) => item.label === label)
    || ENTITY_SOURCE_LEGEND.at(-1);
}

function Field({ label, value, onChange, placeholder, helpText, info, multiline = false, autoGrow = false, type = "text", disabled = false }) {
  const textareaRef = useRef(null);
  useEffect(() => {
    if (!autoGrow || !textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
  }, [autoGrow, value]);
  return (
    <label className="field">
      <span className="field-heading">
        <span>{label}</span>
        {info ? <InfoButton label={label}>{info}</InfoButton> : null}
      </span>
      {helpText ? <small>{helpText}</small> : null}
      {multiline ? (
        <textarea
          ref={textareaRef}
          className={autoGrow ? "auto-grow" : ""}
          rows={autoGrow ? 1 : undefined}
          value={value || ""}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input type={type} value={value || ""} placeholder={placeholder} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
}

function Toggle({ label, checked, onChange, disabled = false }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function StageBadge({ stage }) {
  const normalized = String(stage || "Building").toLowerCase().replace(/\s+/g, "-");
  return <span className={`stage-badge ${normalized}`}>{stage || "Building"}</span>;
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-shell error-shell">
          <div className="panel app-error">
            <AlertCircle size={22} />
            <div>
              <h1>Something went wrong</h1>
              <p>{this.state.error.message || String(this.state.error)}</p>
              <button className="secondary" onClick={() => window.location.reload()}>Reload</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function isWorkspaceLocked(workspace, form, issues = []) {
  const stage = String(workspace?.pipelineStage || "").toLowerCase();
  const buildFinishedWithFixableIssues = Boolean(
    (form?.buildFinishedAt || workspace?.buildFinishedAt) &&
    !hasPublishedForm(workspace) &&
    issues.length
  );
  if (buildFinishedWithFixableIssues) return false;
  return Boolean(
    form?.buildFinishedAt ||
    workspace?.buildFinishedAt ||
    workspace?.hasXml ||
    workspace?.xmlPath ||
    ["publishing", "data collection", "fhir"].includes(stage)
  );
}

function hasPublishedForm(workspace) {
  return Boolean(workspace?.hasXml || workspace?.xmlPath);
}

function hasFinishedBuild(workspace, form) {
  return Boolean(form?.buildFinishedAt || workspace?.buildFinishedAt || hasPublishedForm(workspace));
}

function stageState(stage, workspace) {
  const hasPublished = hasPublishedForm(workspace);
  const hasFhir = Boolean(workspace?.hasFhir || workspace?.fhirBundleCount);
  const hasTerminology = Boolean(workspace?.hasTerminology || workspace?.terminologyStatus === "complete" || workspace?.terminologyStatus === "running");
  if (stage === "build") return hasPublished ? "complete" : "current";
  if (stage === "publish") return hasFhir ? "complete" : hasPublished ? "current" : "waiting";
  if (stage === "terminology") return hasFhir ? "complete" : hasTerminology ? "current" : hasPublished ? "waiting" : "waiting";
  if (stage === "fhir") return hasFhir ? "current" : "waiting";
  return "waiting";
}

function stagePlaceholder(stage, workspace, entries, fhirBundles) {
  if (stage === "publish") {
    return {
      title: "Publishing",
      message: hasPublishedForm(workspace)
        ? `This form is published locally. Filling opens in a separate tab, and ${entries.length} submitted entr${entries.length === 1 ? "y is" : "ies are"} listed here.`
        : "This page is blank because the form has not been exported to XLSForm/XML yet."
    };
  }
  if (stage === "terminology") {
    return {
      title: "Terminology",
      message: "Run terminology extraction from the draft and review every mapped or unmapped vocabulary item before publishing."
    };
  }
  return {
    title: "FHIR",
    message: fhirBundles.length
      ? `FHIR bundles have been generated for ${fhirBundles.length} patient${fhirBundles.length === 1 ? "" : "s"}.`
      : "This page is blank because no filled entries have been passed to the entity mapper yet."
  };
}

function App() {
  const path = window.location.pathname;
  if (path.startsWith("/respondent")) {
    const initialCode = decodeURIComponent(path.replace(/^\/respondent\/?/, "").split("/")[0] || "");
    return <RespondentPortal initialCode={initialCode} />;
  }
  if (path.startsWith("/fill/")) {
    return <FillForm workspaceId={decodeURIComponent(path.replace("/fill/", "").split("/")[0])} />;
  }
  if (path.startsWith("/entry/")) {
    const parts = path.replace("/entry/", "").split("/");
    return <EntryViewer workspaceId={decodeURIComponent(parts[0] || "")} entryId={decodeURIComponent(parts[1] || "")} />;
  }
  return <AdminApp />;
}

function AdminApp() {
  const [token, setToken] = useState(getAdminToken());
  const [authMessage, setAuthMessage] = useState("");

  function handleAuthenticated(nextToken) {
    saveAdminToken(nextToken);
    setToken(nextToken);
    setAuthMessage("");
  }

  function handleLogout(message = "Signed out.") {
    saveAdminToken("");
    saveAdminPassword("");
    setToken("");
    setAuthMessage(message);
  }

  if (!token) {
    return <AccessLanding message={authMessage} onAuthenticated={handleAuthenticated} />;
  }

  return <DashboardApp onLogout={handleLogout} />;
}

function AccessLanding({ message = "", onAuthenticated }) {
  const [activeRole, setActiveRole] = useState("");
  const [password, setPassword] = useState("");
  const [respondentCode, setRespondentCode] = useState("");
  const [status, setStatus] = useState({ kind: message ? "ok" : "idle", message });
  const canAdminLogin = password.trim().length > 0 && status.kind !== "busy";
  const canOpenRespondent = respondentCode.length === 5;

  function selectRole(role) {
    setActiveRole((current) => (current === role ? "" : role));
    if (status.kind !== "busy") setStatus({ kind: "idle", message: "" });
  }

  async function submitAdminLogin(event) {
    event.preventDefault();
    if (!canAdminLogin) return;
    setStatus({ kind: "busy", message: "Checking admin password..." });
    try {
      const response = await fetch(`${API_BASE}/api/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password })
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "Admin login failed.");
      saveAdminPassword(password);
      onAuthenticated(data.token);
    } catch (error) {
      setStatus({ kind: "error", message: error.message || String(error) });
    }
  }

  function submitRespondentCode(event) {
    event.preventDefault();
    const code = normalizeAccessCodeInput(respondentCode);
    if (code.length !== 5) {
      setStatus({ kind: "error", message: "Enter the 5-character respondent form code." });
      return;
    }
    window.location.assign(`/respondent/${encodeURIComponent(code)}`);
  }

  return (
    <div className="access-shell">
      <main className="access-card">
        <div className="access-head">
          <div>
            <h1>ICPH Forms</h1>
            <p>Choose how you want to continue.</p>
          </div>
          <img className="access-logo" src={cdpgLogo} alt="CDPG" />
        </div>

        <div className="access-role-tabs" aria-label="Choose access type">
          <button
            className={`access-role-button ${activeRole === "admin" ? "active" : ""}`}
            aria-expanded={activeRole === "admin"}
            type="button"
            onClick={() => selectRole("admin")}
          >
            <span>Admin</span>
            <ChevronDown size={18} />
          </button>
          <button
            className={`access-role-button ${activeRole === "respondent" ? "active" : ""}`}
            aria-expanded={activeRole === "respondent"}
            type="button"
            onClick={() => selectRole("respondent")}
          >
            <span>Respondent</span>
            <ChevronDown size={18} />
          </button>
        </div>

        <div className="access-collapse-area">
          {activeRole === "admin" ? (
            <form className="access-panel access-panel-open" onSubmit={submitAdminLogin}>
              <div>
                <h2>Admin</h2>
                <p>Build, publish, review terminology, and generate FHIR bundles.</p>
              </div>
              <label className="field">
                <span>Admin password</span>
                <input
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter password"
                  autoFocus
                />
              </label>
              <button className="primary" disabled={!canAdminLogin} type="submit">
                <Check size={16} /> Open Admin
              </button>
            </form>
          ) : null}

          {activeRole === "respondent" ? (
            <form className="access-panel access-panel-open respondent-panel" onSubmit={submitRespondentCode}>
              <div>
                <h2>Respondent</h2>
                <p>Enter the 5-character form code shared by the study team.</p>
              </div>
              <label className="field">
                <span>Form code</span>
                <input
                  className="access-code-input"
                  value={respondentCode}
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  maxLength={5}
                  onChange={(event) => setRespondentCode(normalizeAccessCodeInput(event.target.value))}
                  placeholder="A1B2C"
                  autoFocus
                />
              </label>
              <button className="secondary" disabled={!canOpenRespondent} type="submit">
                <Forward size={16} /> Fill Form
              </button>
            </form>
          ) : null}

          {!activeRole ? (
            <div className="access-empty-hint">
              <p>Select Admin or Respondent to continue.</p>
            </div>
          ) : null}
        </div>

        {status.message ? (
          <div className={`status-line ${status.kind}`}>
            {status.kind === "ok" ? <Check size={16} /> : <AlertCircle size={16} />}
            <span>{status.message}</span>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function RespondentPortal({ initialCode = "" }) {
  const [code, setCode] = useState(normalizeAccessCodeInput(initialCode));
  const [status, setStatus] = useState({ kind: "idle", message: "" });

  function submitCode(event) {
    event.preventDefault();
    const normalized = normalizeAccessCodeInput(code);
    if (normalized.length !== 5) {
      setStatus({ kind: "error", message: "Enter the 5-character respondent form code." });
      return;
    }
    setCode(normalized);
    setStatus({ kind: "idle", message: "" });
    window.history.replaceState(null, "", `/respondent/${encodeURIComponent(normalized)}`);
  }

  if (code.length === 5) {
    return <FillForm accessCode={code} onBackToRespondent={() => {
      setCode("");
      setStatus({ kind: "idle", message: "" });
      window.history.replaceState(null, "", "/respondent");
    }} />;
  }

  return (
    <div className="access-shell respondent-only">
      <main className="access-card respondent-code-card">
        <div className="access-head">
          <div>
            <h1>ICPH Form</h1>
            <p>Enter the form code shared by the study team.</p>
          </div>
          <img className="access-logo" src={cdpgLogo} alt="CDPG" />
        </div>
        <form className="respondent-code-form" onSubmit={submitCode}>
          <label className="field">
            <span>Form code</span>
            <input
              className="access-code-input"
              value={code}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={5}
              autoFocus
              onChange={(event) => setCode(normalizeAccessCodeInput(event.target.value))}
              placeholder="A1B2C"
            />
          </label>
          <button className="primary" disabled={code.length !== 5} type="submit">
            <Forward size={16} /> Continue
          </button>
        </form>
        {status.message ? (
          <div className={`status-line ${status.kind}`}>
            <AlertCircle size={16} />
            <span>{status.message}</span>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function DashboardApp({ onLogout }) {
  const [view, setView] = useState("home");
  const [forms, setForms] = useState([]);
  const [schemaDocuments, setSchemaDocuments] = useState([]);
  const [schemaSummary, setSchemaSummary] = useState(null);
  const [pendingXlsxImport, setPendingXlsxImport] = useState(null);
  const [newFormPromptOpen, setNewFormPromptOpen] = useState(false);
  const [publishIdentifierPrompt, setPublishIdentifierPrompt] = useState(false);
  const [publishConfirmationAccepted, setPublishConfirmationAccepted] = useState(false);
  const [confirmationDialog, setConfirmationDialog] = useState(null);
  const confirmationResolverRef = useRef(null);
  const [form, setForm] = useState(defaultForm());
  const [workspace, setWorkspace] = useState(null);
  const [entries, setEntries] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [fhirBundles, setFhirBundles] = useState([]);
  const [terminology, setTerminology] = useState({ status: "not_started", questions: [] });
  const [activeStage, setActiveStage] = useState("build");
  const [selectedId, setSelectedId] = useState(null);
  const [draggedId, setDraggedId] = useState(null);
  const [status, setStatus] = useState({ kind: "idle", message: "" });

  const selectedQuestion = (form.questions || []).find((question) => question.id === selectedId) || null;
  const issues = useMemo(() => validateForm(form), [form]);
  const attachmentNames = useMemo(() => attachments.map((attachment) => attachment.fileName), [attachments]);
	  const resourceRequirements = useMemo(() => formResourceRequirements(form, attachmentNames), [form, attachmentNames]);
	  const reviewIssue = useMemo(() => terminologyPublishIssue(terminology), [terminology]);
	  const isCopiedVersionDraft = Boolean(form.previousVersionWorkspaceId && !hasPublishedForm(workspace));
	  const copiedVersionHasChanges = hasVersionChanges(form);
	  const copiedVersionChanges = useMemo(() => versionChangeSummary(form), [form]);
	  const missingResourceRequirements = useMemo(
    () => resourceRequirements.filter((item) => !item.uploaded),
    [resourceRequirements]
  );
  const selectedResourceRequirements = selectedQuestion
    ? resourceRequirements.filter((item) => item.questionId === selectedQuestion.id)
    : [];

  async function refreshForms() {
    const data = await requestJson("/api/forms");
    setForms(data.forms || []);
  }

  async function refreshSchemaDocuments() {
    const data = await requestJson("/api/schema-documents");
    setSchemaDocuments(data.documents || []);
    setSchemaSummary(data);
  }

  async function loadEntries(workspaceId) {
    const id = workspaceRouteId(workspaceId);
    const data = await requestJson(`/api/forms/${encodeURIComponent(id)}/entries`);
    setEntries(data.entries || []);
    return data.entries || [];
  }

  async function loadAttachments(workspaceId) {
    const id = workspaceRouteId(workspaceId);
    const data = await requestJson(`/api/forms/${encodeURIComponent(id)}/attachments`);
    setAttachments(data.attachments || []);
  }

  async function loadFhirBundles(workspaceId) {
    const id = workspaceRouteId(workspaceId);
    const data = await requestJson(`/api/forms/${encodeURIComponent(id)}/fhir`);
    setFhirBundles(data.fhirBundles || []);
  }

  async function loadTerminology(workspaceId) {
    const id = workspaceRouteId(workspaceId);
    const data = await requestJson(`/api/forms/${encodeURIComponent(id)}/terminology`);
    setTerminology(data);
    setWorkspace((current) => current && workspaceRouteId(current.workspaceId) === id
      ? {
          ...current,
          hasTerminology: data.status !== "not_started",
          terminologyStatus: data.status,
          terminologyEntityCount: data.entityCount || 0,
          terminologyPath: data.terminologyPath || current.terminologyPath || null
        }
      : current);
    return data;
  }

  useEffect(() => {
    if (!workspace?.workspaceId) return undefined;
    if (terminology?.status !== "running") return undefined;
    const id = workspaceRouteId(workspace.workspaceId);
    let cancelled = false;
    const poll = () => {
      loadTerminology(id).catch((error) => {
        if (!cancelled) setStatus({ kind: "error", message: error.message || String(error) });
      });
    };
    const timer = window.setInterval(poll, 3500);
    poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspace?.workspaceId, activeStage, terminology?.status]);

  useEffect(() => {
    refreshForms().catch(handleRequestError);
    refreshSchemaDocuments().catch(handleRequestError);
  }, []);

  function focusMissingResources(missing = missingResourceRequirements) {
    const first = missing[0];
    if (first?.questionId) setSelectedId(first.questionId);
    setActiveStage("build");
    setStatus({
      kind: "error",
      message: first
        ? `Upload required files before publishing. Missing ${missing.length} file reference${missing.length === 1 ? "" : "s"}; start with ${first.fileName}.`
        : "Upload required files before publishing."
    });
  }

  function changeStage(nextStage) {
    if ((nextStage === "terminology" || nextStage === "publish") && !hasFinishedBuild(workspace, form)) {
      setActiveStage("build");
      setStatus({ kind: "error", message: "Click Build Finished before moving to Terminology or Publish." });
      return;
    }
    if (nextStage === "publish" && !hasPublishedForm(workspace) && missingResourceRequirements.length) {
      focusMissingResources();
      return;
    }
    setActiveStage(nextStage);
  }

  function handleRequestError(error) {
    const message = error?.message || String(error);
    if (error?.status === 401) {
      setStatus({ kind: "error", message: "Admin request was not authorized. Please log out and sign in again if this keeps happening." });
      return;
    }
    if (error?.status === 404 && /workspace not found/i.test(message)) {
      setWorkspace(null);
      setForm(defaultForm());
      setEntries([]);
      setAttachments([]);
      setFhirBundles([]);
      setTerminology({ status: "not_started", questions: [] });
      setSelectedId(null);
      setActiveStage("build");
      setView("home");
      refreshForms().catch(() => {});
      setStatus({
        kind: "error",
        message: `${message}. Returning to Home so you can reopen the current workspace.`
      });
      return;
    }
    setStatus({ kind: "error", message });
  }

  function requestConfirmation(options) {
    return new Promise((resolve) => {
      confirmationResolverRef.current = resolve;
      setConfirmationDialog(options);
    });
  }

  function closeConfirmationDialog(confirmed) {
    const resolver = confirmationResolverRef.current;
    confirmationResolverRef.current = null;
    setConfirmationDialog(null);
    if (resolver) resolver(Boolean(confirmed));
  }

  function updateForm(patch) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function updateQuestion(id, patch) {
    setForm((current) => ({
      ...current,
      questions: current.questions.map((question) => (question.id === id ? { ...question, ...patch } : question))
    }));
  }

  function addQuestion(type) {
    const question = newQuestion(type, form.questions.length);
    setForm((current) => ({ ...current, questions: [...current.questions, question] }));
    setSelectedId(question.id);
    setStatus({ kind: "ok", message: `Added ${questionTypeLabel(type)} as question ${form.questions.length + 1}!` });
  }

  function removeQuestion(id) {
    const label = questionNumberLabel(form, id);
    setForm((current) => ({ ...current, questions: current.questions.filter((question) => question.id !== id) }));
    setSelectedId((current) => (current === id ? null : current));
    setStatus({ kind: "ok", message: `Deleted ${label}.` });
  }

  function duplicateQuestion(question) {
    const sourceLabel = questionNumberLabel(form, question.id);
    const nextNumber = form.questions.length + 1;
    const copy = {
      ...question,
      id: crypto.randomUUID(),
      name: slug(`${question.name}_copy`),
      options: question.options?.map((option) => ({ ...option, id: crypto.randomUUID() }))
    };
    setForm((current) => ({ ...current, questions: [...current.questions, copy] }));
    setSelectedId(copy.id);
    setStatus({ kind: "ok", message: `Duplicated ${sourceLabel} as question ${nextNumber}.` });
  }

  function moveQuestion(targetId) {
    if (!draggedId || draggedId === targetId) return;
    const fromIndex = (form.questions || []).findIndex((question) => question.id === draggedId);
    const toIndex = (form.questions || []).findIndex((question) => question.id === targetId);
    setForm((current) => {
      const questions = [...current.questions];
      const from = questions.findIndex((question) => question.id === draggedId);
      const to = questions.findIndex((question) => question.id === targetId);
      if (from < 0 || to < 0) return current;
      const [item] = questions.splice(from, 1);
      questions.splice(to, 0, item);
      return { ...current, questions };
    });
    if (fromIndex >= 0 && toIndex >= 0) {
      setStatus({ kind: "ok", message: `Moved question ${fromIndex + 1} to position ${toIndex + 1}.` });
    }
  }

  function closeQuestionProperties() {
    if (!selectedId) return;
    const label = questionNumberLabel(form, selectedId);
    setSelectedId(null);
    setStatus({ kind: "ok", message: `Saved ${label}'s properties.` });
  }

  async function createWorkspace(linkage = {}) {
    setStatus({ kind: "busy", message: "Creating form workspace..." });
    try {
      const data = await postJson("/api/forms/new", {
        title: "Untitled ICPH Form",
        formId: "icph_form",
        version: "1",
        linkedMetaFormFileName: linkage.linkedMetaFormFileName,
        primaryIdentifierVariable: linkage.primaryIdentifierVariable,
        metaFormFormIndex: linkage.metaFormFormIndex,
        metaFormFormTitle: linkage.metaFormFormTitle,
        primaryIdentifierAcknowledged: linkage.primaryIdentifierAcknowledged
      });
      setNewFormPromptOpen(false);
      setWorkspace(data);
      setForm(normalizeFormDraft(data.draft));
      setEntries([]);
      setAttachments([]);
      setFhirBundles([]);
      setTerminology({ status: "not_started", questions: [] });
      setActiveStage("build");
      setSelectedId(null);
      setView("builder");
      await refreshForms();
      setStatus({ kind: "ok", message: data.draft?.primaryIdentifierVariable ? `Workspace created with ${data.draft.primaryIdentifierVariable} as the first question.` : `Workspace created: ${data.outputDir}` });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function openWorkspace(workspaceId) {
    const id = workspaceRouteId(workspaceId);
    setStatus({ kind: "busy", message: "Opening form..." });
    try {
      const data = await requestJson(`/api/forms/${encodeURIComponent(id)}`);
      setWorkspace(data);
      setForm(normalizeFormDraft(data.draft));
      setSelectedId(null);
      setActiveStage(data.hasFhir || data.fhirBundleCount > 0 ? "fhir" : hasPublishedForm(data) ? "publish" : data.buildFinishedAt ? "terminology" : "build");
      setView("builder");
      await loadEntries(id);
      await loadAttachments(id);
      await loadFhirBundles(id);
      await loadTerminology(id);
      setStatus({ kind: "ok", message: `Opened ${data.draft?.title || data.title || id}` });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function saveCheckpoint() {
    if (!workspace?.workspaceId) {
      setStatus({ kind: "error", message: "Open or create a form before saving." });
      return;
    }
    setStatus({ kind: "busy", message: "Saving checkpoint..." });
    try {
      const data = await postJson("/api/forms/save", { workspaceId: workspaceRouteId(workspace.workspaceId), form });
      setWorkspace(data);
      setForm(normalizeFormDraft(data.draft));
      await refreshForms();
      setStatus({ kind: "ok", message: `Checkpoint saved: ${data.checkpointPath}` });
    } catch (error) {
      handleRequestError(error);
    }
  }

	  async function finishBuild() {
    if (!workspace?.workspaceId) {
      setStatus({ kind: "error", message: "Open or create a form workspace before finishing Build." });
      return;
    }
    if (issues.length) {
      setStatus({ kind: "error", message: "Fix validation issues before finishing Build." });
      return;
    }
	    if (missingResourceRequirements.length) {
	      focusMissingResources(missingResourceRequirements);
	      return;
	    }
	    if (isCopiedVersionDraft && !copiedVersionHasChanges) {
	      setStatus({ kind: "error", message: "Edit at least one Build item before finishing this new version." });
	      return;
	    }
    const confirmed = await requestConfirmation({
      title: "Finish Build?",
      message: "After this point, the form definition cannot be edited. You can continue to Terminology review and Publish, but Build will be locked.",
      confirmLabel: "Finish Build",
      confirmIcon: "check"
    });
    if (!confirmed) return;
    const finishedAt = form.buildFinishedAt || new Date().toISOString();
    const nextForm = { ...form, buildFinishedAt: finishedAt, updatedAt: finishedAt };
    setStatus({ kind: "busy", message: "Finishing build and locking the form definition..." });
    try {
      const data = await postJson("/api/forms/save", { workspaceId: workspaceRouteId(workspace.workspaceId), form: nextForm });
      setWorkspace((current) => ({ ...current, ...data, buildFinishedAt: finishedAt }));
      setForm(normalizeFormDraft(data.draft));
      setActiveStage("terminology");
      await refreshForms();
      setStatus({ kind: "ok", message: "Build finished. The form definition is locked; run Terminology review next." });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function refreshCurrentEntries() {
    if (!workspace?.workspaceId) {
      setStatus({ kind: "error", message: "Open a workspace before refreshing entries." });
      return;
    }
    setStatus({ kind: "busy", message: "Refreshing entries..." });
    try {
      const nextEntries = await loadEntries(workspace.workspaceId);
      await refreshForms();
      setStatus({ kind: "ok", message: `Loaded ${nextEntries.length} entr${nextEntries.length === 1 ? "y" : "ies"}.` });
    } catch (error) {
      handleRequestError(error);
    }
  }

  function primaryIdentifierCandidates(sourceForm = form) {
    return primaryIdentifierCandidatesForForm(sourceForm);
  }

  async function exportXlsForm(primaryIdentifierVariable = "", options = {}) {
    if (!workspace?.workspaceId) {
      setStatus({ kind: "error", message: "Create a form workspace before export." });
      return;
    }
    if (issues.length) {
      setStatus({ kind: "error", message: "Fix validation issues before export." });
      return;
    }
    const alreadyPublished = hasPublishedForm(workspace);
    if (!alreadyPublished && !hasFinishedBuild(workspace, form)) {
      setActiveStage("build");
      setStatus({ kind: "error", message: "Click Build Finished before moving to Publish." });
      return;
    }
    if (!alreadyPublished && missingResourceRequirements.length) {
      focusMissingResources(missingResourceRequirements);
      return;
    }
    const localReviewIssue = options.terminologyOverride
      ? terminologyPublishIssue(options.terminologyOverride)
      : reviewIssue;
    if (!alreadyPublished) {
	      if (localReviewIssue) {
	        setActiveStage("terminology");
	        setStatus({ kind: "error", message: localReviewIssue });
	        return;
	      }
	    }
    if (!alreadyPublished && isCopiedVersionDraft && !copiedVersionHasChanges) {
	      setActiveStage("build");
	      setStatus({ kind: "error", message: "Edit at least one Build item before publishing this new version." });
	      return;
	    }
    if (!alreadyPublished && !options.publishConfirmed) {
      const confirmed = await requestConfirmation({
        title: "Move to Publish?",
        message: "After this point, the terminology review will be locked and vocabulary mappings cannot be edited. The form will move into local collection.",
        details: form.previousVersionWorkspaceId
          ? [
              `Version ${form.versionNumber || form.version || ""} changes:`,
              ...(copiedVersionChanges.length ? copiedVersionChanges : ["No detected build changes"]).slice(0, 12)
            ]
          : [],
        confirmLabel: "Move to Publish",
        confirmIcon: "forward"
      });
      if (!confirmed) return;
    }
    const explicitPrimaryIdentifier = typeof primaryIdentifierVariable === "string" ? primaryIdentifierVariable : "";
    const selectedPrimaryIdentifier = String(explicitPrimaryIdentifier || form.primaryIdentifierVariable || "").trim();
    const linkedToMetaForm = Boolean(form.metaFormLink?.fileName);
    const identifierCandidates = primaryIdentifierCandidates();
    if (!alreadyPublished && !selectedPrimaryIdentifier) {
      if (linkedToMetaForm) {
        setStatus({
          kind: "error",
          message: "This form is linked to a MetaForm but does not have its shared Primary Identifier Variable saved. Reopen it from Home or recreate the link before publishing."
        });
        return;
      }
      if (!identifierCandidates.length) {
        setStatus({ kind: "error", message: "Add at least one named answer question outside repeats before moving to Publish." });
        return;
      }
      setPublishConfirmationAccepted(true);
      setPublishIdentifierPrompt(true);
      return;
    }
    if (!alreadyPublished && selectedPrimaryIdentifier) {
      const identifierIssue = primaryIdentifierIssue({ ...form, primaryIdentifierVariable: selectedPrimaryIdentifier });
      if (identifierIssue) {
        if (!identifierCandidates.length) {
          setStatus({ kind: "error", message: identifierIssue });
          return;
        }
        setStatus({ kind: "error", message: identifierIssue });
        setPublishConfirmationAccepted(true);
        setPublishIdentifierPrompt(true);
        return;
      }
    }
	    const formForExport = selectedPrimaryIdentifier
	      ? {
	          ...form,
	          primaryIdentifierVariable: selectedPrimaryIdentifier,
	          instanceName: instanceNameForPrimaryIdentifier(selectedPrimaryIdentifier),
	          versionChangeSummary: copiedVersionChanges
	        }
	      : { ...form, versionChangeSummary: copiedVersionChanges };
    setStatus({ kind: "busy", message: "Writing XLSForm and converting XML..." });
    try {
      const data = await postJson("/api/forms/export", { workspaceId: workspaceRouteId(workspace.workspaceId), form: formForExport });
      setWorkspace((current) => ({ ...current, ...data, hasXml: data.ok || data.hasXml }));
      if (data.draft) setForm(normalizeFormDraft(data.draft));
      if (data.terminology) setTerminology(data.terminology);
      if (data.ok) setActiveStage("publish");
      await refreshForms();
      setStatus({
        kind: data.ok ? "ok" : "error",
        message: data.ok
          ? alreadyPublished
            ? `Exported XLSForm and XML: ${data.outputDir}`
            : `Form moved to Publish. Respondent code: ${data.respondentAccessCode || "not generated"}`
          : data.stderr || "XML conversion failed."
      });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function passToMapper() {
    if (!workspace?.workspaceId) {
      setStatus({ kind: "error", message: "Open a form workspace before mapper handoff." });
      return;
    }
    if (!entries.length) {
      setStatus({ kind: "error", message: "Fill and submit at least one entry before passing to the entity mapper." });
      return;
    }
    setStatus({ kind: "busy", message: "Running ICPH entity mapper and generating FHIR bundles..." });
    try {
      const data = await postJson(`/api/forms/${encodeURIComponent(workspaceRouteId(workspace.workspaceId))}/pass-to-mapper`, {});
      setWorkspace((current) => ({ ...current, ...data }));
      setFhirBundles(data.fhirBundles || []);
      setActiveStage("fhir");
      await refreshForms();
      setStatus({
        kind: "ok",
        message: `Generated ${data.fhirBundles?.length || 0} FHIR bundle(s): ${data.mapperResultPath}`
      });
    } catch (error) {
      handleRequestError(error);
    }
  }

	  async function runTerminologyExtraction(questionIds = []) {
	    if (!workspace?.workspaceId) {
	      setStatus({ kind: "error", message: "Open a form workspace before running terminology extraction." });
	      return;
	    }
    if (!hasFinishedBuild(workspace, form)) {
      setActiveStage("build");
      setStatus({ kind: "error", message: "Click Build Finished before running terminology extraction." });
      return;
    }
	    const selectedQuestionIds = Array.isArray(questionIds) ? questionIds.filter(Boolean) : [];
	    setStatus({
	      kind: "busy",
	      message: selectedQuestionIds.length
	        ? `Starting terminology extraction for ${selectedQuestionIds.length} selected question${selectedQuestionIds.length === 1 ? "" : "s"}...`
	        : "Starting terminology extraction..."
	    });
	    try {
	      const data = await postJson(`/api/forms/${encodeURIComponent(workspaceRouteId(workspace.workspaceId))}/terminology`, {
	        questionIds: selectedQuestionIds
	      });
	      setTerminology(data);
      setWorkspace((current) => ({ ...current, hasTerminology: true, terminologyStatus: data.status, terminologyPath: data.terminologyPath || current?.terminologyPath || null }));
      setActiveStage("terminology");
      await refreshForms();
      setStatus({ kind: "ok", message: data.started ? "Terminology extraction started in the background." : "Terminology extraction is already running." });
	    } catch (error) {
	      handleRequestError(error);
		  }
	  }

  async function createNewVersion() {
	    if (!workspace?.workspaceId) {
	      setStatus({ kind: "error", message: "Open a published form before creating a new version." });
	      return;
	    }
	    if (!hasPublishedForm(workspace)) {
	      setStatus({ kind: "error", message: "Publish the current form before creating a new version." });
	      return;
	    }
	    const confirmed = await requestConfirmation({
	      title: "Create a new version?",
	      message: "This copies the form definition, attachments, and terminology review into a new editable workspace. Submitted entries, XML, and FHIR bundles stay with the published version.",
	      confirmLabel: "Create Version",
	      confirmIcon: "copy"
	    });
	    if (!confirmed) return;
	    setStatus({ kind: "busy", message: "Creating new editable version..." });
	    try {
	      const data = await postJson(`/api/forms/${encodeURIComponent(workspaceRouteId(workspace.workspaceId))}/versions`, {});
	      setWorkspace(data);
	      setForm(normalizeFormDraft(data.draft));
	      setEntries([]);
	      await loadAttachments(data.workspaceId);
	      setFhirBundles([]);
	      await loadTerminology(data.workspaceId);
	      setSelectedId(null);
	      setActiveStage("build");
	      setView("builder");
	      await refreshForms();
	      setStatus({ kind: "ok", message: `Created version ${data.draft?.versionNumber || data.draft?.version || ""}. Edit Build before publishing it.` });
		    } catch (error) {
		      handleRequestError(error);
		    }
		  }

	  async function replaceTerminologyMapping(payload) {
    const questionId = String(payload?.questionId || "");
    const entityIndex = Number(payload?.entityIndex);
    const replacement = payload?.replacement || {};
    const approveUnmapped = Boolean(payload?.approveUnmapped);
    const removeApprovedMapping = payload?.removeApprovedMapping || null;
    const questions = Array.isArray(terminology?.questions) ? terminology.questions : [];
    let changed = false;
    let nextTerminology = {
      ...terminology,
      questions: questions.map((question) => {
        if (String(question.id || question.name) !== questionId) return question;
        const entities = Array.isArray(question.entities) ? question.entities : [];
        return {
          ...question,
          entities: entities.map((entity, index) => {
            if (index !== entityIndex) return entity;
            changed = true;
	            const previousSelection = {
	              terminology: entity.terminology || "",
	              code: entity.code || "",
	              term: entity.term || "",
	              approvedMappings: approvedMappingsForEntity(entity),
	              raw: entity.raw || null
	            };
	            const nextCode = String(replacement.code || "");
	            const nextTerm = String(replacement.preferredTerm || replacement.display || replacement.fsn || "");
	            if (approveUnmapped) {
	              return {
	                ...entity,
	                terminology: "",
	                code: "",
	                term: "",
	                approvedMappings: [],
	                validated: true,
	                validationStatus: "unmapped_confirmed",
	                previousSelection,
                raw: {
                  ...(entity.raw || {}),
                  matched_via: "ui_unmapped_review",
                  review_note: "User confirmed that no vocabulary code should be selected."
	                }
	              };
	            }
	            if (removeApprovedMapping) {
	              const removeKey = approvedMappingKey(removeApprovedMapping);
	              const approvedMappings = approvedMappingsForEntity(entity).filter((mapping) => approvedMappingKey(mapping) !== removeKey);
	              return {
	                ...entity,
	                approvedMappings,
	                validated: approvedMappings.length > 0,
	                validationStatus: approvedMappings.length ? "selected" : "",
	                previousSelection,
	                raw: {
	                  ...(entity.raw || {}),
	                  matched_via: approvedMappings.length ? "ui_local_review" : entity.raw?.matched_via
	                }
	              };
	            }
	            const approvedMapping = normalizeApprovedMapping({
	              ...replacement,
	              term: nextTerm,
	              vocabulary: replacement.vocabulary || vocabularyKey(replacement.vocabularyLabel || replacement.terminology || entity.terminology)
	            });
	            if (!approvedMapping) return entity;
	            const approvedMappingsByKey = new Map(
	              approvedMappingsForEntity(entity).map((mapping) => [approvedMappingKey(mapping), mapping])
	            );
	            approvedMappingsByKey.set(approvedMappingKey(approvedMapping), approvedMapping);
	            const approvedMappings = Array.from(approvedMappingsByKey.values());
	            return {
	              ...entity,
	              terminology: approvedMapping.vocabularyLabel,
	              code: approvedMapping.code,
	              term: approvedMapping.term || approvedMapping.display,
	              approvedMappings,
	              validated: true,
	              validationStatus: previousSelection.code && previousSelection.code !== approvedMapping.code ? "replaced" : "selected",
	              previousSelection,
	              raw: {
	                ...(entity.raw || {}),
	                concept_id: approvedMapping.code,
	                term: approvedMapping.term || approvedMapping.display,
	                fsn: approvedMapping.fsn || approvedMapping.display,
	                system_uri: approvedMapping.systemUri || entity.raw?.system_uri || "http://snomed.info/sct",
	                vocabulary: approvedMapping.vocabulary,
	                approved_mappings: approvedMappings,
	                matched_via: "ui_local_review"
	              }
            };
          })
        };
      })
    };
    if (!changed) return terminology;
    setTerminology(nextTerminology);
    if (workspace?.workspaceId && nextTerminology) {
      const saved = await postJson(`/api/forms/${encodeURIComponent(workspaceRouteId(workspace.workspaceId))}/terminology/review`, {
        terminology: nextTerminology
      });
      if (saved?.questions) {
        nextTerminology = saved;
        setTerminology(saved);
      }
    }
    setStatus({ kind: "ok", message: "Vocabulary review updated locally. Publish is unlocked only after every entity is reviewed." });
    return nextTerminology;
  }

  async function leaveAllTerminologyUnmappedAndPublish() {
    if (!workspace?.workspaceId) {
      setStatus({ kind: "error", message: "Open a form workspace before moving to Publish." });
      return;
    }
    const stats = terminologyReviewStats(terminology);
    const hasExtractedEntities = stats.total > 0;
    const confirmed = await requestConfirmation({
      title: "Leave Everything Unmapped?",
      message: hasExtractedEntities
        ? "Every terminology entity will be marked as reviewed with no vocabulary code selected, then the form will move to Publish. This locks terminology review for this version."
        : "Terminology extraction will be skipped, no vocabulary codes will be attached, and the form will move to Publish. This locks terminology review for this version.",
      details: hasExtractedEntities
        ? [`${stats.pending} pending item${stats.pending === 1 ? "" : "s"} will be marked unmapped.`, `${stats.total} total terminology item${stats.total === 1 ? "" : "s"} will have no approved mapping.`]
        : ["No terminology extraction results are required for this action.", "FHIR generation will use the form definition and submitted answers without approved vocabulary mappings."],
      confirmLabel: "Leave Unmapped and Publish",
      confirmIcon: "forward",
      danger: true
    });
    if (!confirmed) return;

    const previousTerminology = terminology || {};
    const now = new Date().toISOString();
    const nextTerminology = {
      ...previousTerminology,
      ok: true,
      status: "skipped_unmapped",
      completedAt: previousTerminology.completedAt || now,
      skippedAt: now,
      skipReason: "User chose to leave all terminology unmapped and move to Publish.",
      questions: (Array.isArray(previousTerminology.questions) ? previousTerminology.questions : []).map((question) => ({
        ...question,
        entities: (Array.isArray(question.entities) ? question.entities : []).map((entity) => ({
          ...entity,
          previousSelection: {
            terminology: entity.terminology || "",
            code: entity.code || "",
            term: entity.term || "",
            approvedMappings: approvedMappingsForEntity(entity),
            raw: entity.raw || null
          },
          terminology: "",
          code: "",
          term: "",
          approvedMappings: [],
          validated: true,
          validationStatus: "unmapped_confirmed",
          raw: {
            ...(entity.raw || {}),
            matched_via: "ui_bulk_unmapped_publish",
            review_note: "User confirmed that all terminology entities should remain unmapped before publishing.",
            reviewed_at: now
          }
        }))
      }))
    };

    setStatus({ kind: "busy", message: "Marking terminology entities unmapped..." });
    try {
      const saved = await postJson(`/api/forms/${encodeURIComponent(workspaceRouteId(workspace.workspaceId))}/terminology/review`, {
        terminology: nextTerminology
      });
      const savedTerminology = saved?.questions ? saved : nextTerminology;
      setTerminology(savedTerminology);
      await exportXlsForm("", { publishConfirmed: true, terminologyOverride: savedTerminology });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function addTerminologyEntity(payload) {
    const questionId = String(payload?.questionId || "");
    const entityText = String(payload?.entityText || "").replace(/\s+/g, " ").trim();
    if (!questionId) throw new Error("Choose a question before adding an entity.");
    if (!entityText) throw new Error("Enter the entity text to add.");

    const questions = Array.isArray(terminology?.questions) ? terminology.questions : [];
    let changed = false;
    let addedEntityIndex = -1;
    const nextQuestions = questions.map((question) => {
      const questionKey = String(question.id || question.name);
      const questionName = String(question.name || "");
      if (questionKey !== questionId && questionName !== questionId) return question;
      const entities = Array.isArray(question.entities) ? question.entities : [];
      const duplicate = entities.some((entity) => manualEntityKey(entity.entity || entity.originalEntity) === manualEntityKey(entityText));
      if (duplicate) {
        throw new Error(`"${entityText}" is already listed for this question.`);
      }
      addedEntityIndex = entities.length;
      changed = true;
      return {
        ...question,
        status: question.status || "complete",
        entities: [
          ...entities,
          {
            entity: entityText,
            originalEntity: entityText,
            sourceComponent: "manual",
            sourceLabel: "Added by admin",
            sourceText: entityText,
            sourceQuestion: question.name || question.id || "",
            decompositionMethod: "ui_manual_entity",
            terminology: "",
            code: "",
            term: "",
            negated: false,
            allergy: false,
            raw: {
              entity: entityText,
              original_entity: entityText,
              matched_via: "ui_manual_entity",
              confidence: "Manual",
              source_question: question.name || question.id || "",
              source_component: "manual",
              source_label: "Added by admin",
              source_text: entityText,
              review_note: "Admin manually added this entity from the Terminology tab."
            },
            approvedMappings: [],
            validated: false,
            validationStatus: ""
          }
        ]
      };
    });
    if (!changed) throw new Error("Could not find the selected terminology question.");

    let nextTerminology = {
      ...terminology,
      ok: terminology.ok !== false,
      status: terminology.status || "complete",
      questions: nextQuestions,
      entityCount: nextQuestions.reduce((sum, question) => sum + (question.entities?.length || 0), 0),
      reviewUpdatedAt: new Date().toISOString()
    };
    setTerminology(nextTerminology);
    if (workspace?.workspaceId) {
      const saved = await postJson(`/api/forms/${encodeURIComponent(workspaceRouteId(workspace.workspaceId))}/terminology/review`, {
        terminology: nextTerminology
      });
      if (saved?.questions) {
        nextTerminology = saved;
        setTerminology(saved);
      }
    }
    const savedQuestion = (nextTerminology.questions || []).find((question) => {
      const questionKey = String(question.id || question.name);
      const questionName = String(question.name || "");
      return questionKey === questionId || questionName === questionId;
    });
    const savedEntityIndex = (savedQuestion?.entities || []).findIndex((entity) => manualEntityKey(entity.entity || entity.originalEntity) === manualEntityKey(entityText));
    setStatus({ kind: "ok", message: `Added "${entityText}" as a terminology entity. Review and approve or confirm unmapped before publishing.` });
    return { terminology: nextTerminology, question: savedQuestion, entityIndex: savedEntityIndex >= 0 ? savedEntityIndex : addedEntityIndex };
  }

  async function importXlsx(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setStatus({ kind: "busy", message: `Inspecting ${file.name}...` });
    try {
      const dataBase64 = await fileToBase64(file);
      const data = await postJson("/api/forms/inspect-xlsx", { filename: file.name, dataBase64 });
      setPendingXlsxImport({
        filename: file.name,
        dataBase64,
        title: data.title,
        formId: data.formId,
        variables: data.variables || [],
        variableCount: data.variableCount || 0
      });
      setStatus({
        kind: "ok",
        message: `Inspected ${file.name}. Choose its primary identifier and optional MetaForm link.`
      });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function confirmXlsxImport(linkage) {
    if (!pendingXlsxImport) return;
    setStatus({ kind: "busy", message: `Importing ${pendingXlsxImport.filename}...` });
    try {
      const data = await postJson("/api/forms/import-xlsx", {
        filename: pendingXlsxImport.filename,
        dataBase64: pendingXlsxImport.dataBase64,
        linkedMetaFormFileName: linkage.linkedMetaFormFileName,
        primaryIdentifierVariable: linkage.primaryIdentifierVariable,
        metaFormFormIndex: linkage.metaFormFormIndex,
        metaFormFormTitle: linkage.metaFormFormTitle,
        primaryIdentifierAcknowledged: linkage.primaryIdentifierAcknowledged,
        addMissingPrimaryIdentifier: linkage.addMissingPrimaryIdentifier
      });
      setPendingXlsxImport(null);
	      const importedForm = normalizeFormDraft({
	        ...data.draft,
	        primaryIdentifierVariable: data.draft?.primaryIdentifierVariable || linkage.primaryIdentifierVariable,
	        instanceName: data.draft?.instanceName || instanceNameForPrimaryIdentifier(linkage.primaryIdentifierVariable)
	      });
      const importedAttachments = data.attachments || [];
      const importedResourceRequirements = formResourceRequirements(
        importedForm,
        importedAttachments.map((attachment) => attachment.fileName)
      );
      setWorkspace(data);
      setForm(importedForm);
      setEntries([]);
      setAttachments(importedAttachments);
      setFhirBundles([]);
      setTerminology({ status: "not_started", questions: [] });
      setActiveStage("build");
      setSelectedId(importedResourceRequirements[0]?.questionId || null);
      setView("builder");
      await refreshForms();
      setStatus({
        kind: data.ok ? "ok" : "error",
        message: data.ok
          ? importedResourceRequirements.length
            ? `Imported XLSForm. ${importedResourceRequirements.filter((item) => !item.uploaded).length} referenced file(s) need upload before publishing.`
            : `Imported XLSForm: ${data.outputDir}`
          : data.stderr || "Import failed."
      });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function uploadSchemaDocument(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".docx")) {
      setStatus({ kind: "error", message: "Please upload a DOCX schema metadata document." });
      return;
    }
    setStatus({ kind: "busy", message: `Uploading schema metadata document: ${file.name}...` });
    try {
      const dataBase64 = await fileToBase64(file);
      const data = await postJson("/api/schema-documents/upload", { filename: file.name, dataBase64 });
      setSchemaDocuments(data.documents || []);
      setSchemaSummary(data);
      setStatus({ kind: "ok", message: `Uploaded ${data.fileName}. Click Process to make it available for FHIR conversion.` });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function processSchemaDocuments(fileName = "") {
    setStatus({ kind: "busy", message: fileName ? `Processing ${fileName}...` : "Processing schema metadata documents..." });
    try {
      const data = await postJson("/api/schema-documents/process", { fileName });
      setSchemaDocuments(data.documents || []);
      setSchemaSummary(data);
      setStatus({ kind: "ok", message: `Schema metadata processed. Aggregate chunks: ${data.aggregateChunkCount || 0}.` });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function deleteSchemaDocument(fileName) {
    const confirmed = await requestConfirmation({
      title: "Delete MetaForm?",
      message: `Delete schema metadata document "${fileName}"? This removes the uploaded DOCX and its processed Markdown/chunks. Existing FHIR bundles will not be changed.`,
      confirmLabel: "Delete",
      confirmIcon: "trash",
      danger: true
    });
    if (!confirmed) return;
    setStatus({ kind: "busy", message: `Deleting ${fileName}...` });
    try {
      const data = await deleteJson(`/api/schema-documents/${encodeURIComponent(fileName)}`);
      setSchemaDocuments(data.documents || []);
      setSchemaSummary(data);
      setStatus({ kind: "ok", message: `Deleted schema metadata document: ${fileName}` });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function deleteWorkspace(workspaceId, title) {
    const id = workspaceRouteId(workspaceId);
    const confirmed = await requestConfirmation({
      title: "Delete Form?",
      message: `Delete "${title || id}"? This will permanently remove its backend folder, including XLSForm, XML, entries, and FHIR bundles.`,
      confirmLabel: "Delete",
      confirmIcon: "trash",
      danger: true
    });
    if (!confirmed) return;
    setStatus({ kind: "busy", message: "Deleting form workspace..." });
    try {
      const data = await deleteJson(`/api/forms/${encodeURIComponent(id)}`);
      if (workspaceRouteId(workspace?.workspaceId) === id) {
        setWorkspace(null);
        setForm(defaultForm());
        setEntries([]);
        setAttachments([]);
        setFhirBundles([]);
        setTerminology({ status: "not_started", questions: [] });
        setSelectedId(null);
        setView("home");
      }
      await refreshForms();
      setStatus({ kind: "ok", message: `Deleted: ${data.deletedPath}` });
    } catch (error) {
      handleRequestError(error);
    }
  }

  function backHome() {
    setView("home");
    setSelectedId(null);
    refreshForms().catch(() => {});
  }

  function fillForm(workspaceId) {
    window.open(`/fill/${encodeURIComponent(workspaceRouteId(workspaceId))}`, "_blank", "noopener,noreferrer");
  }

  async function uploadWorkspaceAttachments(workspaceId, event) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    const id = workspaceRouteId(workspaceId);
    if (!id || !files.length) return;
    setStatus({ kind: "busy", message: `Uploading ${files.length} attachment${files.length === 1 ? "" : "s"}...` });
    try {
      let latest = null;
      for (const file of files) {
        const dataBase64 = await fileToBase64(file);
        latest = await postJson(`/api/forms/${encodeURIComponent(id)}/attachments`, {
          filename: file.name,
          dataBase64
        });
      }
      if (workspaceRouteId(workspace?.workspaceId) === id) {
        setAttachments(latest?.attachments || []);
        setWorkspace((current) => ({ ...current, ...(latest || {}) }));
      }
      await refreshForms();
      const nextAttachments = latest?.attachments || [];
      const missingAfter = formResourceRequirements(
        form,
        nextAttachments.map((attachment) => attachment.fileName)
      ).filter((item) => !item.uploaded);
      setStatus({
        kind: missingAfter.length ? "error" : "ok",
        message: missingAfter.length
          ? `Uploaded ${files.length} file${files.length === 1 ? "" : "s"}, but ${missingAfter.length} required file reference${missingAfter.length === 1 ? "" : "s"} still need upload.`
          : `Uploaded ${files.length} attachment${files.length === 1 ? "" : "s"}. All referenced files are ready.`
      });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function uploadWorkspaceResource(workspaceId, expectedFileName, event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    const id = workspaceRouteId(workspaceId);
    if (!id || !file || !expectedFileName) return;
    setStatus({ kind: "busy", message: `Uploading ${expectedFileName}...` });
    try {
      const dataBase64 = await fileToBase64(file);
      const data = await postJson(`/api/forms/${encodeURIComponent(id)}/attachments`, {
        filename: expectedFileName,
        dataBase64
      });
      if (workspaceRouteId(workspace?.workspaceId) === id) {
        setAttachments(data.attachments || []);
        setWorkspace((current) => ({ ...current, ...data }));
      }
      await refreshForms();
      const missingAfter = formResourceRequirements(
        form,
        (data.attachments || []).map((attachment) => attachment.fileName)
      ).filter((item) => !item.uploaded);
      setStatus({
        kind: missingAfter.length ? "error" : "ok",
        message: missingAfter.length
          ? `Uploaded ${expectedFileName}. ${missingAfter.length} required file reference${missingAfter.length === 1 ? "" : "s"} still need upload.`
          : `Uploaded resource: ${expectedFileName}. All referenced files are ready.`
      });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function uploadQuestionMedia(questionId, fieldName, event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    const id = workspaceRouteId(workspace?.workspaceId);
    if (!id || !file || !questionId || !fieldName) {
      setStatus({ kind: "error", message: "Open a form workspace before uploading media." });
      return;
    }
    setStatus({ kind: "busy", message: `Uploading ${file.name}...` });
    try {
      const dataBase64 = await fileToBase64(file);
      const data = await postJson(`/api/forms/${encodeURIComponent(id)}/attachments`, {
        filename: file.name,
        dataBase64
      });
      updateQuestion(questionId, { [fieldName]: file.name });
      setAttachments(data.attachments || []);
      setWorkspace((current) => ({ ...current, ...data }));
      await refreshForms();
      setStatus({ kind: "ok", message: `Uploaded ${file.name} and linked it to the question ${fieldName} column.` });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function deleteWorkspaceAttachment(workspaceId, fileName) {
    const id = workspaceRouteId(workspaceId);
    if (!id || !fileName) return;
    const confirmed = await requestConfirmation({
      title: "Delete Attachment?",
      message: `Delete attachment "${fileName}" from this form workspace?`,
      confirmLabel: "Delete",
      confirmIcon: "trash",
      danger: true
    });
    if (!confirmed) return;
    setStatus({ kind: "busy", message: `Deleting ${fileName}...` });
    try {
      const data = await deleteJson(`/api/forms/${encodeURIComponent(id)}/attachments/${encodeURIComponent(fileName)}`);
      if (workspaceRouteId(workspace?.workspaceId) === id) {
        setAttachments(data.attachments || []);
        setWorkspace((current) => ({ ...current, ...data }));
      }
      await refreshForms();
      setStatus({ kind: "ok", message: `Deleted attachment: ${fileName}` });
    } catch (error) {
      handleRequestError(error);
    }
  }

  function viewEntry(workspaceId, entryId) {
    window.open(`/entry/${encodeURIComponent(workspaceRouteId(workspaceId))}/${encodeURIComponent(entryId)}`, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="app-shell">
      {view === "home" ? (
        <HomePage
          forms={forms}
          schemaDocuments={schemaDocuments}
          schemaSummary={schemaSummary}
          status={status}
          createWorkspace={() => setNewFormPromptOpen(true)}
          importXlsx={importXlsx}
          uploadSchemaDocument={uploadSchemaDocument}
          processSchemaDocuments={processSchemaDocuments}
          deleteSchemaDocument={deleteSchemaDocument}
          openWorkspace={openWorkspace}
          fillForm={fillForm}
          deleteWorkspace={deleteWorkspace}
          onLogout={onLogout}
          pendingXlsxImport={pendingXlsxImport}
          confirmXlsxImport={confirmXlsxImport}
          cancelXlsxImport={() => setPendingXlsxImport(null)}
          newFormPromptOpen={newFormPromptOpen}
          confirmNewForm={createWorkspace}
          cancelNewForm={() => setNewFormPromptOpen(false)}
        />
      ) : (
        <BuilderPage
          form={form}
          workspace={workspace}
          entries={entries}
          attachments={attachments}
          terminology={terminology}
          resourceRequirements={resourceRequirements}
          selectedResourceRequirements={selectedResourceRequirements}
          fhirBundles={fhirBundles}
          selectedId={selectedId}
          selectedQuestion={selectedQuestion}
          draggedId={draggedId}
          status={status}
          issues={issues}
          activeStage={activeStage}
          setActiveStage={changeStage}
          setDraggedId={setDraggedId}
          updateForm={updateForm}
          updateQuestion={updateQuestion}
          addQuestion={addQuestion}
          removeQuestion={removeQuestion}
          duplicateQuestion={duplicateQuestion}
          moveQuestion={moveQuestion}
          setSelectedId={setSelectedId}
          closeQuestionProperties={closeQuestionProperties}
          saveCheckpoint={saveCheckpoint}
          finishBuild={finishBuild}
          exportXlsForm={exportXlsForm}
	          runTerminologyExtraction={runTerminologyExtraction}
	          replaceTerminologyMapping={replaceTerminologyMapping}
	          addTerminologyEntity={addTerminologyEntity}
	          reviewIssue={reviewIssue}
	          isCopiedVersionDraft={isCopiedVersionDraft}
	          copiedVersionHasChanges={copiedVersionHasChanges}
	          createNewVersion={createNewVersion}
	          leaveAllTerminologyUnmappedAndPublish={leaveAllTerminologyUnmappedAndPublish}
	          passToMapper={passToMapper}
          backHome={backHome}
          fillForm={fillForm}
          uploadWorkspaceAttachments={uploadWorkspaceAttachments}
          uploadWorkspaceResource={uploadWorkspaceResource}
          uploadQuestionMedia={uploadQuestionMedia}
          deleteWorkspaceAttachment={deleteWorkspaceAttachment}
          viewEntry={viewEntry}
          refreshEntries={refreshCurrentEntries}
          onLogout={onLogout}
        />
      )}
      {publishIdentifierPrompt ? (
        <PublishIdentifierModal
          form={form}
          status={status}
          candidates={primaryIdentifierCandidates()}
          onCancel={() => {
            setPublishIdentifierPrompt(false);
            setPublishConfirmationAccepted(false);
          }}
          onPublish={(primaryIdentifierVariable) => {
            const publishConfirmed = publishConfirmationAccepted;
            setPublishIdentifierPrompt(false);
            setPublishConfirmationAccepted(false);
            exportXlsForm(primaryIdentifierVariable, { publishConfirmed });
          }}
        />
      ) : null}
      {confirmationDialog ? (
        <ConfirmationModal
          {...confirmationDialog}
          onCancel={() => closeConfirmationDialog(false)}
          onConfirm={() => closeConfirmationDialog(true)}
        />
      ) : null}
    </div>
  );
}

function HomePage({
  forms,
  schemaDocuments,
  schemaSummary,
  status,
  createWorkspace,
  importXlsx,
  uploadSchemaDocument,
  processSchemaDocuments,
  deleteSchemaDocument,
  openWorkspace,
  fillForm,
  deleteWorkspace,
  onLogout,
  pendingXlsxImport,
  confirmXlsxImport,
  cancelXlsxImport,
  newFormPromptOpen,
  confirmNewForm,
  cancelNewForm
	}) {
	  const homeRef = useRef(null);
	  const [connectors, setConnectors] = useState([]);
	  const [selectedVersionByGroup, setSelectedVersionByGroup] = useState({});
	  const versionGroups = useMemo(() => {
	    const map = new Map();
	    for (const item of forms) {
	      const groupKey = item.versionBaseId || String(item.workspaceId || "").replace(/_v\d+$/i, "");
	      const group = map.get(groupKey) || { groupKey, versions: [] };
	      group.versions.push(item);
	      map.set(groupKey, group);
	    }
	    return [...map.values()]
	      .map((group) => ({
	        ...group,
	        versions: group.versions.sort((a, b) => (Number(a.versionNumber || 1) - Number(b.versionNumber || 1)))
	      }))
	      .sort((a, b) => String(b.versions.at(-1)?.updatedAt || "").localeCompare(String(a.versions.at(-1)?.updatedAt || "")));
	  }, [forms]);
	  const versionCards = versionGroups.map((group) => {
	    const selectedId = selectedVersionByGroup[group.groupKey];
	    const selected = group.versions.find((item) => item.workspaceId === selectedId) || group.versions.at(-1);
	    return { ...group, selected };
	  });
	  const linkedFormsByMetaForm = versionCards.reduce((map, group) => {
	    const item = group.selected;
	    const fileName = item.metaFormLink?.fileName;
	    if (!fileName) return map;
	    map.set(fileName, [...(map.get(fileName) || []), item]);
	    return map;
	  }, new Map());

  useEffect(() => {
    const root = homeRef.current;
    if (!root) return undefined;

    function measureConnectors() {
      const rootRect = root.getBoundingClientRect();
      const metaRows = new Map(
        [...root.querySelectorAll("[data-metaform-file]")]
          .map((node) => [node.dataset.metaformFile, node])
      );
      const next = [];
      for (const xlsRow of root.querySelectorAll("[data-linked-metaform]")) {
        const metaRow = metaRows.get(xlsRow.dataset.linkedMetaform);
        if (!metaRow) continue;
        const source = metaRow.getBoundingClientRect();
        const target = xlsRow.getBoundingClientRect();
        const x1 = source.right - rootRect.left;
        const y1 = source.top + source.height / 2 - rootRect.top;
        const x2 = target.left - rootRect.left;
        const y2 = target.top + target.height / 2 - rootRect.top;
        if (x2 <= x1 + 24) continue;
        const bend = Math.max(28, (x2 - x1) / 2);
        next.push({
          id: `${xlsRow.dataset.workspaceId}-${xlsRow.dataset.linkedMetaform}`,
          path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
        });
      }
      setConnectors(next);
    }

    const frame = window.requestAnimationFrame(measureConnectors);
    const observer = new ResizeObserver(measureConnectors);
    observer.observe(root);
    for (const row of root.querySelectorAll("[data-metaform-file], [data-linked-metaform]")) observer.observe(row);
    window.addEventListener("resize", measureConnectors);
    window.addEventListener("scroll", measureConnectors, true);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measureConnectors);
      window.removeEventListener("scroll", measureConnectors, true);
    };
	  }, [forms, schemaDocuments, selectedVersionByGroup]);

  return (
    <>
      <header className="topbar home-topbar">
        <div className="topbar-actions">
          <button className="secondary topbar-logout" onClick={() => onLogout?.("Signed out.")}>
            <X size={14} /> Logout
          </button>
        </div>
        <div className="topbar-title">
          <h1>ICPH Forms</h1>
          <p>Connect MetaForms with generated XLSForms for context and tracking.</p>
        </div>
        <div className="topbar-brand">
          <img className="topbar-logo" src={cdpgLogo} alt="CDPG" />
        </div>
      </header>

      <main className="home-layout" ref={homeRef}>
        {connectors.length ? (
          <svg className="link-connectors" aria-hidden="true">
            {connectors.map((connector) => (
              <path key={connector.id} d={connector.path} />
            ))}
          </svg>
        ) : null}
        <section className="home-column metaforms-column">
          <SchemaDocumentsPanel
            documents={schemaDocuments}
            summary={schemaSummary}
            status={status}
            uploadSchemaDocument={uploadSchemaDocument}
            processSchemaDocuments={processSchemaDocuments}
            deleteSchemaDocument={deleteSchemaDocument}
            linkedFormsByMetaForm={linkedFormsByMetaForm}
          />
        </section>

        <section className="home-column xlsforms-column">
          <div className="home-column-head">
            <div>
              <h2>XLS Forms</h2>
	              <p>{versionGroups.length} form families · {forms.length} versions</p>
              <XlsFormsNote />
            </div>
            <div className="home-column-actions">
              <button className="primary small" onClick={createWorkspace}>
                <Plus size={14} /> New
              </button>
              <label className="secondary small file-action">
                <Import size={14} /> Upload XLS
                <input type="file" accept=".xlsx" onChange={importXlsx} />
              </label>
            </div>
          </div>
	          {forms.length === 0 ? (
            <div className="empty-state tall">
              <ClipboardList size={36} />
              <p>No XLS forms yet.</p>
            </div>
	          ) : (
	            <div className="forms-list">
	              {versionCards.map((group) => {
	                const item = group.selected;
	                return (
	                <article
	                  className="form-card"
	                  key={item.workspaceId}
                  data-workspace-id={item.workspaceId}
                  data-linked-metaform={item.metaFormLink?.fileName || undefined}
                >
                  <div className="card-head">
                    <div className="card-head-main">
	                      <h3>{item.title}</h3>
	                      <p>{item.formId || item.workspaceId}</p>
	                      {group.versions.length > 1 ? (
	                        <label className="version-picker">
	                          <span>Version</span>
	                          <select
	                            value={item.workspaceId}
	                            onChange={(event) => setSelectedVersionByGroup((current) => ({
	                              ...current,
	                              [group.groupKey]: event.target.value
	                            }))}
	                          >
	                            {group.versions.map((version) => (
	                              <option key={version.workspaceId} value={version.workspaceId}>
	                                v{version.versionNumber || 1} · {version.pipelineStage}
	                              </option>
	                            ))}
	                          </select>
	                        </label>
	                      ) : null}
	                    </div>
                    <div className="card-head-aside">
                      <StageBadge stage={item.pipelineStage} />
                      <div className="card-metrics">
                        <span>{item.questionCount} questions</span>
                        <span>{item.entryCount} entries</span>
                        <span>{item.fhirBundleCount || 0} FHIR bundles</span>
                        <span>{item.attachmentCount || 0} attachments</span>
                      </div>
                    </div>
                  </div>
                  {item.metaFormLink?.fileName ? (
                    <div className="form-linkage">
                      <span>MetaForm: <strong>{item.metaFormLink.fileName}</strong></span>
                      <span>Primary ID: <strong>{item.primaryIdentifierVariable || "Not selected"}</strong></span>
                    </div>
                  ) : item.primaryIdentifierVariable ? (
                    <div className="form-linkage custom">
                      <span>Custom form</span>
                      <span>Primary ID: <strong>{item.primaryIdentifierVariable}</strong></span>
                    </div>
                  ) : (
                    <div className="form-linkage unlinked">
                      <AlertCircle size={15} />
                      <span>Not linked to a MetaForm</span>
                    </div>
                  )}
                  {item.respondentAccessCode ? (
                    <div className="respondent-code-row">
                      <span>Respondent form code</span>
                      <strong>{item.respondentAccessCode}</strong>
                    </div>
                  ) : null}
                  <p className="mono">{item.outputDir}</p>
                  <div className="card-actions">
                    <button className="secondary" onClick={() => openWorkspace(item.workspaceId)}>
                      <FolderOpen size={16} /> Open
                    </button>
                    {item.hasXml ? (
                      <button className="primary" onClick={() => fillForm(item.workspaceId)}>
                        <ExternalLink size={16} /> Fill Form
                      </button>
                    ) : null}
                    <button className="secondary danger-action" onClick={() => deleteWorkspace(item.workspaceId, item.title)}>
                      <Trash2 size={16} /> Delete
	                    </button>
	                  </div>
	                </article>
	              );
	              })}
	            </div>
          )}
        </section>
      </main>
      <footer className="builder-footer home-footer" aria-label="Page status">
        <div className={`footer-status ${status.kind}`}>
          {status.kind === "ok" ? <Check size={16} /> : status.kind === "busy" ? <RefreshCw size={16} /> : <AlertCircle size={16} />}
          <span>{status.message || "Ready."}</span>
        </div>
      </footer>
      {pendingXlsxImport ? (
        <XlsImportLinkModal
          pending={pendingXlsxImport}
          documents={schemaDocuments}
          forms={forms}
          status={status}
          onCancel={cancelXlsxImport}
          onImport={confirmXlsxImport}
        />
      ) : null}
      {newFormPromptOpen ? (
        <NewFormLinkModal
          documents={schemaDocuments}
          forms={forms}
          status={status}
          onCancel={cancelNewForm}
          onCreate={confirmNewForm}
        />
      ) : null}
    </>
  );
}

function XlsFormsNote() {
  const [open, setOpen] = useState(false);
  return (
    <span className="xls-note-wrap">
      <button className="link-button xls-note-link" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        Note!
      </button>
      {open ? (
        <span className="xls-note-popover" role="note">
          <span>Browser filling may not fully support barcode, background-audio, and audit inputs.</span>
          <span>XLSForm import reads workbook sheets such as survey, choices, settings, and entities. Upload companion files from Builder before publishing.</span>
          <span>FHIR bundles use the XLSForm/form builder definition and submitted answers. MetaForms are kept for context and later grouping.</span>
          <span>If a form references external CSV/media/map files, open Builder and upload them there before publishing. FHIR creation uses the form and its submitted answers, not the linked MetaForm.</span>
        </span>
      ) : null}
    </span>
  );
}

function SchemaDocumentsPanel({ documents, summary, status, uploadSchemaDocument, processSchemaDocuments, deleteSchemaDocument, linkedFormsByMetaForm }) {
  const needsProcessing = documents.some((document) => document.status !== "Processed");
  return (
    <section className="schema-panel">
      <div className="home-column-head">
        <div>
          <h2>MetaForms</h2>
          <p>{documents.length} schema documents</p>
        </div>
        <div className="home-column-actions">
          <label className="secondary small file-action schema-upload">
            <Upload size={14} /> Upload MetaForm
            <input type="file" accept=".docx" onChange={uploadSchemaDocument} />
          </label>
          <button className="secondary small" disabled={!documents.length || status.kind === "busy"} onClick={() => processSchemaDocuments()}>
            <Settings size={14} /> Process
          </button>
        </div>
      </div>
      <p className="schema-context-subtitle">
        MetaForms are retained for protocol context and linking multiple XLS forms together. They are not used during FHIR bundle creation.
      </p>
      {needsProcessing ? (
        <p className="schema-warning">One or more documents need processing before they can appear as searchable/linkable MetaForm context.</p>
      ) : null}
      {documents.length === 0 ? (
        <div className="empty-state compact">
          <FileText size={28} />
          <p>No MetaForms uploaded yet.</p>
        </div>
      ) : (
        <div className="schema-doc-list">
          {documents.map((document) => (
            <article className="schema-doc" key={document.fileName} data-metaform-file={document.fileName}>
              <div className="schema-doc-head">
                <div className="schema-doc-main">
                  <FileText size={17} />
                  <div>
                    <h3>{document.fileName}</h3>
                    <p>{document.status}</p>
                  </div>
                </div>
                <div className="schema-doc-actions">
                  <button className="secondary small" disabled={status.kind === "busy"} onClick={() => processSchemaDocuments(document.fileName)}>
                    <Settings size={14} /> Process
                  </button>
                  <button className="secondary small danger-action" disabled={status.kind === "busy"} onClick={() => deleteSchemaDocument(document.fileName)}>
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              </div>
              <div className="schema-metrics">
                <span>{document.formCount || 0} forms</span>
                <span>{document.variableCount || 0} variables</span>
                <span>{document.chunkCount || 0} chunks</span>
                <span>{linkedFormsByMetaForm?.get(document.fileName)?.length || 0} XLS links</span>
              </div>
              {linkedFormsByMetaForm?.get(document.fileName)?.find((item) => item.primaryIdentifierVariable) ? (
                <p className="schema-primary-hint">
                  Primary Identifier Variable: <strong>{linkedFormsByMetaForm.get(document.fileName).find((item) => item.primaryIdentifierVariable).primaryIdentifierVariable}</strong>
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
      <p className="mono schema-path">{summary?.processedDir || "processedMD path will appear here"}</p>
    </section>
  );
}

function NewFormLinkModal({ documents, forms = [], status, onCancel, onCreate }) {
  const processedDocuments = documents.filter((document) => document.status === "Processed");
  const [linkedChoice, setLinkedChoice] = useState("");
  const [linkedMetaFormFileName, setLinkedMetaFormFileName] = useState("");
  const [metaFormFormIndex, setMetaFormFormIndex] = useState("");
  const [primaryIdentifierVariable, setPrimaryIdentifierVariable] = useState("");
  const [primaryIdentifierAcknowledged, setPrimaryIdentifierAcknowledged] = useState(false);
  const isLinked = linkedChoice === "yes";
  const selectedMetaForm = processedDocuments.find((document) => document.fileName === linkedMetaFormFileName) || null;
  const linkedForms = linkedMetaFormFileName
    ? forms.filter((item) => item.metaFormLink?.fileName === linkedMetaFormFileName && item.primaryIdentifierVariable)
    : [];
  const existingPrimaryIdentifier = linkedForms[0]?.primaryIdentifierVariable || "";
  const primaryIdentifierLocked = Boolean(isLinked && existingPrimaryIdentifier);
  const formOptions = selectedMetaForm
    ? selectedMetaForm.formOptions?.length
      ? selectedMetaForm.formOptions
      : Array.from({ length: selectedMetaForm.formCount || 0 }, (_, index) => ({
          formIndex: index + 1,
          title: `Form ${index + 1}`,
          variableCount: 0,
          variables: []
        }))
    : [];
  const selectedFormOption = formOptions.find((item) => String(item.formIndex) === String(metaFormFormIndex)) || null;
  const variables = selectedFormOption?.variables || [];
  const effectivePrimaryIdentifier = primaryIdentifierLocked ? existingPrimaryIdentifier : primaryIdentifierVariable;
  const primaryOptions = primaryIdentifierLocked
    ? [{ name: existingPrimaryIdentifier, label: "Primary identifier from linked MetaForm" }, ...variables.filter((item) => item.name !== existingPrimaryIdentifier)]
    : variables;
  const canCreate = Boolean(
    status.kind !== "busy" &&
    linkedChoice &&
    (
      !isLinked ||
      (
        linkedMetaFormFileName &&
        metaFormFormIndex &&
        effectivePrimaryIdentifier &&
        primaryIdentifierAcknowledged
      )
    )
  );

  useEffect(() => {
    if (linkedChoice !== "yes") {
      setLinkedMetaFormFileName("");
      setMetaFormFormIndex("");
      setPrimaryIdentifierVariable("");
      setPrimaryIdentifierAcknowledged(false);
    }
  }, [linkedChoice]);

  useEffect(() => {
    setMetaFormFormIndex("");
    setPrimaryIdentifierVariable("");
    setPrimaryIdentifierAcknowledged(false);
  }, [linkedMetaFormFileName]);

  useEffect(() => {
    if (primaryIdentifierLocked) {
      setPrimaryIdentifierVariable(existingPrimaryIdentifier);
      return;
    }
    setPrimaryIdentifierVariable(variables[0]?.name || "");
  }, [existingPrimaryIdentifier, primaryIdentifierLocked, metaFormFormIndex]);

  const createLabel = primaryIdentifierLocked
    ? "Add the Primary Identifier Variable from the MetaForm and Begin Building"
    : isLinked
      ? "Proceed"
      : "Begin Building";

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="link-modal new-form-modal" role="dialog" aria-modal="true" aria-label="Create new form">
        <div className="modal-head">
          <div>
            <h2>Create New Form</h2>
            <p>Start a blank XLSForm workspace, optionally linked to a MetaForm.</p>
          </div>
          <button className="icon-button" onClick={onCancel} aria-label="Close create form dialog">
            <X size={15} />
          </button>
        </div>

        <div className="new-form-question">
          <span>Is this new form linked to any MetaForm?</span>
          <div className="choice-buttons">
            <button
              className={linkedChoice === "yes" ? "choice-button selected" : "choice-button"}
              type="button"
              onClick={() => setLinkedChoice("yes")}
            >
              Yes
            </button>
            <button
              className={linkedChoice === "no" ? "choice-button selected" : "choice-button"}
              type="button"
              onClick={() => setLinkedChoice("no")}
            >
              No
            </button>
          </div>
        </div>

        {isLinked ? (
          <>
            <div className="link-form">
              <label className="field">
                <span>Linked MetaForm</span>
                <select value={linkedMetaFormFileName} onChange={(event) => setLinkedMetaFormFileName(event.target.value)}>
                  <option value="">Choose MetaForm</option>
                  {processedDocuments.map((document) => (
                    <option key={document.fileName} value={document.fileName}>
                      {document.fileName} · {document.formCount || 0} forms · {document.variableCount || 0} variables
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Which form is this in the MetaForm?</span>
                <select value={metaFormFormIndex} disabled={!linkedMetaFormFileName} onChange={(event) => setMetaFormFormIndex(event.target.value)}>
                  <option value="">Choose MetaForm form</option>
                  {formOptions.map((item) => (
                    <option key={item.formIndex} value={item.formIndex}>
                      {item.title || `Form ${item.formIndex}`}{item.variableCount ? ` · ${item.variableCount} variables` : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {metaFormFormIndex ? (
              <div className="link-form link-form-secondary">
                <label className="field">
                  <span>Primary Identifier Variable</span>
                  <select
                    value={effectivePrimaryIdentifier}
                    disabled={primaryIdentifierLocked || !variables.length}
                    onChange={(event) => setPrimaryIdentifierVariable(event.target.value)}
                  >
                    {primaryOptions.length ? primaryOptions.map((variable) => (
                      <option key={variable.name} value={variable.name}>
                        {variable.name}{variable.label ? ` · ${variable.label}` : ""}
                      </option>
                    )) : (
                      <option value="">No variables found in this MetaForm form</option>
                    )}
                  </select>
                </label>

                <label className="acknowledgement-box">
                  <input
                    type="checkbox"
                    checked={primaryIdentifierAcknowledged}
                    onChange={(event) => setPrimaryIdentifierAcknowledged(event.target.checked)}
                  />
                  <span>
                    I acknowledge that <strong>{effectivePrimaryIdentifier || "the selected variable"}</strong> is the common Primary Identifier Variable for every form linked to <strong>{linkedMetaFormFileName}</strong>.
                  </span>
                </label>
              </div>
            ) : null}

            {primaryIdentifierLocked ? (
              <p className="modal-subtle-note">
                This MetaForm already uses <strong>{existingPrimaryIdentifier}</strong> as its Primary Identifier Variable, so the new form will start with that question.
              </p>
            ) : null}
          </>
        ) : null}

        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button
            className="primary"
            disabled={!canCreate}
            onClick={() => onCreate({
              linkedMetaFormFileName: isLinked ? linkedMetaFormFileName : "",
              primaryIdentifierVariable: isLinked ? effectivePrimaryIdentifier : "",
              metaFormFormIndex: isLinked ? metaFormFormIndex : "",
              metaFormFormTitle: selectedFormOption?.title || "",
              primaryIdentifierAcknowledged: isLinked ? primaryIdentifierAcknowledged : false
            })}
          >
            <Plus size={16} /> {createLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function XlsImportLinkModal({ pending, documents, forms = [], status, onCancel, onImport }) {
  const processedDocuments = documents.filter((document) => document.status === "Processed");
  const variables = pending.variables || [];
  const [linkedMetaFormFileName, setLinkedMetaFormFileName] = useState("");
  const [primaryIdentifierVariable, setPrimaryIdentifierVariable] = useState(variables[0]?.name || "");
  const [metaFormFormIndex, setMetaFormFormIndex] = useState("");
  const [primaryIdentifierAcknowledged, setPrimaryIdentifierAcknowledged] = useState(false);
  const selectedMetaForm = processedDocuments.find((document) => document.fileName === linkedMetaFormFileName) || null;
  const linkedForms = linkedMetaFormFileName
    ? forms.filter((item) => item.metaFormLink?.fileName === linkedMetaFormFileName && item.primaryIdentifierVariable)
    : [];
  const existingPrimaryIdentifier = linkedForms[0]?.primaryIdentifierVariable || "";
  const primaryIdentifierLocked = Boolean(linkedMetaFormFileName && existingPrimaryIdentifier);
  const effectivePrimaryIdentifier = primaryIdentifierLocked ? existingPrimaryIdentifier : primaryIdentifierVariable;
  const variableNames = new Set(variables.map((variable) => variable.name));
  const primaryIdentifierMissing = Boolean(primaryIdentifierLocked && effectivePrimaryIdentifier && !variableNames.has(effectivePrimaryIdentifier));
  const formOptions = selectedMetaForm
    ? selectedMetaForm.formOptions?.length
      ? selectedMetaForm.formOptions
      : Array.from({ length: selectedMetaForm.formCount || 0 }, (_, index) => ({
          formIndex: index + 1,
          title: `Form ${index + 1}`,
          variableCount: 0
        }))
    : [];
  const selectedFormOption = formOptions.find((item) => String(item.formIndex) === String(metaFormFormIndex)) || null;
  const primaryOptions = primaryIdentifierMissing
    ? [{ name: effectivePrimaryIdentifier, label: "Primary identifier from linked MetaForm" }, ...variables]
    : variables;
  const needsMetaFormDetails = Boolean(linkedMetaFormFileName);
  const canImport = Boolean(
    effectivePrimaryIdentifier &&
    status.kind !== "busy" &&
    (!needsMetaFormDetails || (metaFormFormIndex && primaryIdentifierAcknowledged)) &&
    (!primaryIdentifierMissing || primaryIdentifierLocked)
  );

  useEffect(() => {
    if (!linkedMetaFormFileName) {
      setPrimaryIdentifierAcknowledged(false);
      setMetaFormFormIndex("");
      return;
    }
    if (primaryIdentifierLocked) setPrimaryIdentifierVariable(existingPrimaryIdentifier);
    setPrimaryIdentifierAcknowledged(false);
    setMetaFormFormIndex("");
  }, [existingPrimaryIdentifier, linkedMetaFormFileName, primaryIdentifierLocked]);

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="link-modal" role="dialog" aria-modal="true" aria-label="Import XLSForm">
        <div className="modal-head">
          <div>
            <h2>Import XLS Form</h2>
            <p>{pending.title || pending.filename} · {pending.variableCount || variables.length} variables</p>
          </div>
          <button className="icon-button" onClick={onCancel} aria-label="Close link dialog">
            <X size={15} />
          </button>
        </div>

        <div className="link-form">
          <label className="field">
            <span>Linked MetaForm</span>
            <select value={linkedMetaFormFileName} onChange={(event) => setLinkedMetaFormFileName(event.target.value)}>
              <option value="">No MetaForm link</option>
              {processedDocuments.map((document) => (
                <option key={document.fileName} value={document.fileName}>
                  {document.fileName} · {document.formCount || 0} forms · {document.variableCount || 0} variables
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Primary Identifier Variable</span>
            <select
              value={effectivePrimaryIdentifier}
              disabled={primaryIdentifierLocked}
              onChange={(event) => setPrimaryIdentifierVariable(event.target.value)}
            >
              {primaryOptions.map((variable) => (
                <option key={variable.name} value={variable.name}>
                  {variable.name}{variable.label ? ` · ${variable.label}` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        {needsMetaFormDetails ? (
          <div className="link-form link-form-secondary">
            <label className="field">
              <span>Which form is this in the MetaForm?</span>
              <select value={metaFormFormIndex} onChange={(event) => setMetaFormFormIndex(event.target.value)}>
                <option value="">Choose MetaForm form</option>
                {formOptions.map((item) => (
                  <option key={item.formIndex} value={item.formIndex}>
                    {item.title || `Form ${item.formIndex}`}{item.variableCount ? ` · ${item.variableCount} variables` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="acknowledgement-box">
              <input
                type="checkbox"
                checked={primaryIdentifierAcknowledged}
                onChange={(event) => setPrimaryIdentifierAcknowledged(event.target.checked)}
              />
              <span>
                I acknowledge that <strong>{effectivePrimaryIdentifier || "the selected variable"}</strong> is the common Primary Identifier Variable for every form linked to <strong>{linkedMetaFormFileName}</strong>.
              </span>
            </label>
          </div>
        ) : null}

        {primaryIdentifierLocked ? (
          <p className="modal-subtle-note">
            This MetaForm already uses <strong>{existingPrimaryIdentifier}</strong> as its Primary Identifier Variable, so it is locked for this import.
          </p>
        ) : null}

        <div className="xls-resource-note modal-note">
          <AlertCircle size={16} />
          <span>
            This import reads the XLSForm workbook sheets. If the form references companion files such as external CSV choices,
            label media, audio, video, or GeoJSON, upload those files from the Builder after import.
            MetaForm links are saved only as context; FHIR bundles use the imported form and submitted answers.
          </span>
        </div>

        <div className="variable-preview">
          <div className="section-head">
            <h3>XLS name column</h3>
            <span>{variables.length} variables</span>
          </div>
          <div className="variable-list">
            {variables.slice(0, 80).map((variable) => (
              <button
                className={variable.name === effectivePrimaryIdentifier ? "variable-row selected" : "variable-row"}
                disabled={primaryIdentifierLocked}
                key={variable.name}
                onClick={() => setPrimaryIdentifierVariable(variable.name)}
              >
                <span className="mono">{variable.name}</span>
                <span>{variable.label || variable.type || "No label"}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button
            className="primary"
            disabled={!canImport}
            onClick={() => onImport({
              linkedMetaFormFileName,
              primaryIdentifierVariable: effectivePrimaryIdentifier,
              metaFormFormIndex,
              metaFormFormTitle: selectedFormOption?.title || "",
              primaryIdentifierAcknowledged,
              addMissingPrimaryIdentifier: primaryIdentifierMissing
            })}
          >
            <Import size={16} /> {primaryIdentifierMissing ? "Add the Primary Identifier Variable from the MetaForm and Import XLS" : "Import XLS"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PublishIdentifierModal({ form, candidates, status, onCancel, onPublish }) {
  const initialPrimaryIdentifier = candidates.some((candidate) => candidate.name === form.primaryIdentifierVariable)
    ? form.primaryIdentifierVariable
    : candidates[0]?.name || "";
  const [primaryIdentifierVariable, setPrimaryIdentifierVariable] = useState(initialPrimaryIdentifier);
  const canPublish = candidates.some((candidate) => candidate.name === primaryIdentifierVariable) && status.kind !== "busy";

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="link-modal" role="dialog" aria-modal="true" aria-label="Choose primary identifier">
        <div className="modal-head">
          <div>
            <h2>Choose Primary Identifier</h2>
            <p>{form.title || "Untitled form"} · {candidates.length} variables</p>
          </div>
          <button className="icon-button" onClick={onCancel} aria-label="Close identifier dialog">
            <X size={15} />
          </button>
        </div>

        <label className="field">
          <span>Primary Identifier Variable</span>
          <select value={primaryIdentifierVariable} onChange={(event) => setPrimaryIdentifierVariable(event.target.value)}>
            {candidates.map((variable) => (
              <option key={variable.name} value={variable.name}>
                {variable.name}{variable.label ? ` · ${variable.label}` : ""}
              </option>
            ))}
          </select>
        </label>

        <div className="variable-preview">
          <div className="section-head">
            <h3>Form variables</h3>
            <span>{candidates.length} variables</span>
          </div>
          <div className="variable-list">
            {candidates.map((variable) => (
              <button
                className={variable.name === primaryIdentifierVariable ? "variable-row selected" : "variable-row"}
                key={variable.name}
                onClick={() => setPrimaryIdentifierVariable(variable.name)}
              >
                <span className="mono">{variable.name}</span>
                <span>{variable.label || variable.type || "No label"}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!canPublish} onClick={() => onPublish(primaryIdentifierVariable)}>
            <Forward size={16} /> Move to Publish
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmationModal({ title, message, details = [], confirmLabel = "Confirm", cancelLabel = "Cancel", confirmIcon = "check", danger = false, onCancel, onConfirm }) {
  const Icon = confirmIcon === "forward" ? Forward : confirmIcon === "copy" ? Copy : confirmIcon === "trash" ? Trash2 : Check;
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="link-modal confirmation-modal" role="dialog" aria-modal="true" aria-label={title || "Confirm action"}>
        <div className="modal-head">
          <div>
            <h2>{title || "Confirm action"}</h2>
            {message ? <p>{message}</p> : null}
          </div>
          <button className="icon-button" onClick={onCancel} aria-label="Close confirmation dialog">
            <X size={15} />
          </button>
        </div>
        {details.length ? (
          <div className="confirmation-details">
            {details.map((item, index) => (
              <span key={`${item}_${index}`}>{item}</span>
            ))}
          </div>
        ) : null}
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>{cancelLabel}</button>
          <button className={danger ? "primary danger-confirm" : "primary"} onClick={onConfirm}>
            <Icon size={16} /> {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function BuilderPage(props) {
  const {
    form,
    workspace,
    entries,
    attachments,
    terminology,
    resourceRequirements,
    selectedResourceRequirements,
    fhirBundles,
    selectedQuestion,
    selectedId,
    status,
    issues,
    activeStage,
    setActiveStage,
    updateForm,
    updateQuestion,
    addQuestion,
    removeQuestion,
    duplicateQuestion,
    moveQuestion,
    setDraggedId,
    setSelectedId,
    closeQuestionProperties,
    saveCheckpoint,
    finishBuild,
    exportXlsForm,
	    runTerminologyExtraction,
	    replaceTerminologyMapping,
	    addTerminologyEntity,
	    reviewIssue,
	    isCopiedVersionDraft,
	    copiedVersionHasChanges,
	    createNewVersion,
	    leaveAllTerminologyUnmappedAndPublish,
	    passToMapper,
    backHome,
    fillForm,
    uploadWorkspaceAttachments,
    uploadWorkspaceResource,
    uploadQuestionMedia,
    deleteWorkspaceAttachment,
    viewEntry,
    refreshEntries,
    onLogout
  } = props;
	  const locked = isWorkspaceLocked(workspace, form, issues);
	  const published = hasPublishedForm(workspace);
	  const buildFinished = hasFinishedBuild(workspace, form);
	  const currentStage = activeStage === "fhir"
	    ? "FHIR"
	    : activeStage === "publish" && published
	      ? entries.length ? "Data collection" : "Publishing"
	      : workspace?.pipelineStage || (buildFinished ? "Terminology" : "Building");
  const stages = [
    { id: "build", label: "Build" },
    { id: "terminology", label: "Terminology" },
    { id: "publish", label: "Publish" },
    { id: "fhir", label: "FHIR Bundle" }
  ];
  const fhirPlaceholder = stagePlaceholder("fhir", workspace, entries, fhirBundles);
  const terminologyPlaceholder = stagePlaceholder("terminology", workspace, entries, fhirBundles);
  const [questionTypeToAdd, setQuestionTypeToAdd] = useState(QUESTION_TYPES[0]?.type || "text");

  return (
    <>
      <header className="topbar form-topbar">
        <div className="topbar-actions">
          <button className="secondary topbar-home" onClick={backHome}><Home size={18} /> Home</button>
          <button className="secondary topbar-logout" onClick={() => onLogout?.("Signed out.")}>
            <X size={14} /> Logout
          </button>
        </div>
        <div className="topbar-title">
          <h1>{form.title || "ICPH Form Builder"}</h1>
          <p>Build, checkpoint, export, and collect locally in one form workspace.</p>
        </div>
        <div className="topbar-brand">
          <img className="topbar-logo" src={cdpgLogo} alt="CDPG" />
        </div>
        <nav className="stage-tabs" aria-label="Form stages">
          {stages.map((stage) => (
            <button
              key={stage.id}
              className={`stage-tab ${activeStage === stage.id ? "active" : ""} ${stageState(stage.id, workspace)}`}
              onClick={() => setActiveStage(stage.id)}
            >
              {stage.label}
            </button>
          ))}
        </nav>
      </header>

      {activeStage === "fhir" ? (
        <main className="fhir-layout">
          {fhirBundles.length ? (
            <section className="publish-stack">
              <div className="panel publish-summary">
                <StageBadge stage={currentStage} />
                <h2>FHIR</h2>
                <p>FHIR bundles generated from submitted entries are available below.</p>
              </div>
              <FhirPanel fhirBundles={fhirBundles} form={form} />
            </section>
          ) : (
            <section className="panel stage-placeholder">
              <StageBadge stage={currentStage} />
              <h2>{fhirPlaceholder.title}</h2>
              <p>{fhirPlaceholder.message}</p>
              {published && entries.length ? (
                <button className="primary" disabled={status.kind === "busy"} onClick={passToMapper}>
                  <Forward size={18} /> Generate FHIR Bundles
                </button>
              ) : published ? (
                <button className="secondary" onClick={() => fillForm(workspace.workspaceId)}>
                  <ExternalLink size={18} /> Fill Form First
                </button>
              ) : null}
            </section>
          )}
        </main>
      ) : activeStage === "terminology" ? (
        <main className="publish-layout">
          <TerminologyPanel
            form={form}
            workspace={workspace}
            terminology={terminology}
	            status={status}
	            runTerminologyExtraction={runTerminologyExtraction}
	            replaceTerminologyMapping={replaceTerminologyMapping}
	            addTerminologyEntity={addTerminologyEntity}
	            reviewIssue={reviewIssue}
            locked={published}
	          />
        </main>
      ) : activeStage === "publish" ? (
        <main className="publish-layout">
          <section className="publish-stack">
            <div className="panel publish-summary">
              <StageBadge stage={currentStage} />
              <h2>Publish</h2>
              <p>{published ? "This form is published locally. Fill it in the browser, inspect submitted entries, then generate FHIR bundles." : "Move the form to Publish after vocabulary review is complete."}</p>
              {published && workspace?.respondentAccessCode ? (
                <div className="respondent-code-callout">
                  <span>Respondent form code</span>
                  <strong>{workspace.respondentAccessCode}</strong>
                  <p>Share this 5-character code with respondents. They can enter it from the respondent page without an admin password.</p>
                </div>
              ) : null}
            </div>
            <EntriesPanel form={form} entries={entries} workspaceId={workspace?.workspaceId} viewEntry={viewEntry} refreshEntries={refreshEntries} status={status} />
          </section>
        </main>
      ) : (
      <main className={`layout ${locked ? "layout-locked" : ""}`}>
        {!locked ? (
          <aside className="panel palette">
            <h2>Question Types</h2>
            <div className="question-type-picker">
              <select value={questionTypeToAdd} onChange={(event) => setQuestionTypeToAdd(event.target.value)}>
                {QUESTION_TYPES.map((item) => (
                  <option key={item.type} value={item.type}>{item.label}</option>
                ))}
              </select>
              <button className="primary" onClick={() => addQuestion(questionTypeToAdd)}>
                <Plus size={16} /> Add Question
              </button>
            </div>

            <div className="side-form-meta">
              <Field
                label="Form Title"
                value={form.title}
                disabled={locked}
                info={settingInfoText("form_title")}
                multiline
                autoGrow
                onChange={(value) => updateForm({ title: value })}
              />
              <Field
                label="Form ID"
                value={form.formId}
                disabled={locked}
                info={settingInfoText("form_id")}
                multiline
                autoGrow
                onChange={(value) => updateForm({ formId: value })}
              />
              <Field
                label="Version"
                value={form.version}
                disabled={locked}
                info={settingInfoText("version")}
                multiline
                autoGrow
                onChange={(value) => updateForm({ version: value })}
              />
              <Field
                label="Instance Name"
                value={form.instanceName}
                disabled={locked}
                info={settingInfoText("instance_name")}
                multiline
                autoGrow
                onChange={(value) => updateForm({ instanceName: value })}
              />
              <Field
                label="Style"
                value={form.style}
                disabled={locked}
                info={settingInfoText("style")}
                multiline
                autoGrow
                onChange={(value) => updateForm({ style: value })}
              />
              <Field
                label="Submission URL"
                value={form.submissionUrl}
                disabled={locked}
                info={settingInfoText("submission_url")}
                multiline
                autoGrow
                onChange={(value) => updateForm({ submissionUrl: value })}
              />
            </div>

            <div className="status-card">
              <div className="status-title">
                <FileSpreadsheet size={18} />
                Workspace
              </div>
              <p className="mono">{workspace?.outputDir || "No workspace loaded"}</p>
              <div className="mini-metrics">
                <span>{entries.length} entries</span>
                <span>{fhirBundles.length} FHIR bundles</span>
                <span>{currentStage}</span>
              </div>
            </div>

          </aside>
        ) : null}

        <section className="builder">
          {locked ? (
            <div className="locked-workspace">
              <div className="status-title">
                <FileSpreadsheet size={18} />
                <span>Workspace</span>
              </div>
              <p className="mono">{workspace?.outputDir || "No workspace loaded"}</p>
              <div className="mini-metrics">
                <span>{entries.length} entries</span>
                <span>{fhirBundles.length} FHIR bundles</span>
                <span>{currentStage}</span>
              </div>
            </div>
          ) : null}

	          {resourceRequirements.length ? (
            <BuildResourcesPanel
              workspace={workspace}
              attachments={attachments}
              requirements={resourceRequirements}
              status={status}
              locked={locked}
              uploadWorkspaceAttachments={uploadWorkspaceAttachments}
              deleteWorkspaceAttachment={deleteWorkspaceAttachment}
              setSelectedId={setSelectedId}
            />
          ) : null}

          <QuestionList
            form={form}
            resourceRequirements={resourceRequirements}
            locked={locked}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            setDraggedId={setDraggedId}
            moveQuestion={moveQuestion}
            duplicateQuestion={duplicateQuestion}
            removeQuestion={removeQuestion}
          />

	          <div className="build-validation">
	            <ValidationPanel issues={issues} />
	          </div>
        </section>

        {selectedQuestion ? (
          <aside className="panel editor editor-drawer" aria-label="Selected question properties">
            <button className="drawer-collapse" onClick={closeQuestionProperties} aria-label="Collapse properties panel">
              <ChevronRight size={20} />
            </button>
            <div className="drawer-scroll">
              <div className="drawer-head">
                <div>
                  <h2>Properties</h2>
                  <p>{selectedQuestion.label || selectedQuestion.name}</p>
                </div>
                <button className="icon-button" onClick={closeQuestionProperties} aria-label="Close properties">
                  <X size={18} />
                </button>
              </div>
              {selectedResourceRequirements.length ? (
	              <QuestionResourcesBox
	                workspace={workspace}
	                requirements={selectedResourceRequirements}
	                status={status}
	                locked={locked}
	                uploadWorkspaceAttachments={uploadWorkspaceAttachments}
	                uploadWorkspaceResource={uploadWorkspaceResource}
	                deleteWorkspaceAttachment={deleteWorkspaceAttachment}
	              />
              ) : null}
              <QuestionEditor
                form={form}
                question={selectedQuestion}
                updateQuestion={updateQuestion}
                uploadQuestionMedia={uploadQuestionMedia}
                readOnly={locked}
              />
            </div>
          </aside>
        ) : null}
      </main>
      )}
        <BuilderFooter
        activeStage={activeStage}
        status={status}
        locked={locked}
        published={published}
        buildFinished={buildFinished}
        issues={issues}
        resourceRequirements={resourceRequirements}
        entries={entries}
        workspace={workspace}
        saveCheckpoint={saveCheckpoint}
	        finishBuild={finishBuild}
	        exportXlsForm={exportXlsForm}
	        fillForm={fillForm}
	        refreshEntries={refreshEntries}
	        passToMapper={passToMapper}
	        goToPublish={() => setActiveStage("publish")}
	        reviewIssue={reviewIssue}
	        isCopiedVersionDraft={isCopiedVersionDraft}
	        copiedVersionHasChanges={copiedVersionHasChanges}
	        createNewVersion={createNewVersion}
	        leaveAllTerminologyUnmappedAndPublish={leaveAllTerminologyUnmappedAndPublish}
	      />
    </>
  );
}

function BuilderFooter({
  activeStage,
  status,
  locked,
  published,
  buildFinished,
  issues,
  resourceRequirements,
  entries,
  workspace,
	  saveCheckpoint,
	  finishBuild,
	  exportXlsForm,
	  fillForm,
	  refreshEntries,
	  passToMapper,
	  goToPublish,
	  reviewIssue,
	  isCopiedVersionDraft,
	  copiedVersionHasChanges,
	  createNewVersion,
	  leaveAllTerminologyUnmappedAndPublish
	}) {
	  const missingResources = resourceRequirements.some((item) => !item.uploaded);
	  const busy = status.kind === "busy";
  const publishDisabledReason = !published && activeStage === "terminology"
    ? !buildFinished
      ? "Click Build Finished before moving to Publish."
      : issues.length > 0
        ? `Fix ${issues.length} validation issue${issues.length === 1 ? "" : "s"} before moving to Publish.`
        : reviewIssue
          ? reviewIssue
          : isCopiedVersionDraft && !copiedVersionHasChanges
            ? "Edit at least one Build item before this new version can be published."
            : ""
    : "";
	  const footerMessage = activeStage === "terminology" && reviewIssue
	    ? reviewIssue
      : publishDisabledReason
        ? publishDisabledReason
	    : isCopiedVersionDraft && !copiedVersionHasChanges
	      ? "Edit at least one Build item before this new version can be published."
	      : status.message || "Ready";
	  const footerKind = activeStage === "terminology" && (reviewIssue || publishDisabledReason) ? "error" : status.kind;
	  return (
	    <footer className="builder-footer" aria-label="Page actions">
	      <div className={`footer-status ${footerKind}`}>
	        {footerKind === "ok" ? <Check size={16} /> : <AlertCircle size={16} />}
	        <span>{footerMessage}</span>
	      </div>
      <div className="footer-actions">
        <button className="secondary" disabled={locked || busy} onClick={saveCheckpoint}>
          <Save size={16} /> Save Checkpoint
        </button>
        {activeStage === "build" ? (
	            <button
	              className="primary"
	              disabled={locked || busy || issues.length > 0 || missingResources || (isCopiedVersionDraft && !copiedVersionHasChanges)}
	              onClick={finishBuild}
	            >
            <Check size={16} /> Build Finished
          </button>
        ) : null}
	        {activeStage === "terminology" ? (
	          <>
	            {!published ? (
	              <button
	                className="secondary"
	                disabled={busy || !buildFinished || issues.length > 0 || (isCopiedVersionDraft && !copiedVersionHasChanges)}
	                onClick={leaveAllTerminologyUnmappedAndPublish}
	              >
	                <X size={16} /> Leave everything unmapped and move to Publish
	              </button>
	            ) : null}
	            <button
	              className="primary"
	              disabled={published ? busy : busy || !buildFinished || issues.length > 0 || Boolean(reviewIssue) || (isCopiedVersionDraft && !copiedVersionHasChanges)}
	              onClick={() => (published ? goToPublish?.() : exportXlsForm())}
	            >
	              <Forward size={16} /> {published ? "Publish -->" : "Move to Publish"}
	            </button>
	          </>
        ) : null}
        {activeStage === "publish" && published ? (
          <>
            <button className="primary" disabled={!workspace?.workspaceId} onClick={() => fillForm(workspace.workspaceId)}>
              <ExternalLink size={16} /> Fill Form
            </button>
            <button className="secondary" disabled={busy} onClick={refreshEntries}>
              <RefreshCw size={16} /> Refresh Entries
            </button>
	            <button className="secondary" disabled={!entries.length || busy} onClick={passToMapper}>
	              <Forward size={16} /> Generate FHIR
	            </button>
	            <button className="secondary" disabled={busy} onClick={createNewVersion}>
	              <Copy size={16} /> Create New Version
	            </button>
	          </>
        ) : null}
        {activeStage === "fhir" && published ? (
          <button className="secondary" disabled={!entries.length || busy} onClick={passToMapper}>
            <Forward size={16} /> Regenerate FHIR
          </button>
        ) : null}
      </div>
    </footer>
  );
}

function BuildResourcesPanel({ workspace, attachments = [], requirements, status, locked = false, uploadWorkspaceAttachments, deleteWorkspaceAttachment, setSelectedId }) {
  const workspaceId = workspace?.workspaceId || "";
  const missing = requirements.filter((item) => !item.uploaded);
  const uploadedFiles = [
    ...new Set([
      ...attachments.map((attachment) => attachment.fileName).filter(Boolean),
      ...requirements.filter((item) => item.uploaded).map((item) => item.fileName)
    ])
  ].sort((a, b) => a.localeCompare(b));
  return (
    <div className="panel build-resources-panel">
      <div className="section-head">
        <div>
          <h2>Referenced Files</h2>
          <p>{missing.length ? `${missing.length} file reference${missing.length === 1 ? "" : "s"} still need upload before publishing.` : "All referenced files are uploaded."}</p>
        </div>
        <label className="secondary small file-action">
          <Upload size={14} /> Upload Files
          <input
            type="file"
            multiple
	            disabled={locked || !workspaceId || status.kind === "busy"}
            onChange={(event) => uploadWorkspaceAttachments(workspaceId, event)}
          />
        </label>
      </div>
      {missing.length ? (
        <div className="resource-list compact">
          {missing.slice(0, 8).map((item) => (
            <button className="resource-row missing" key={item.id} onClick={() => setSelectedId(item.questionId)}>
              <span className="resource-file">{item.fileName}</span>
              <span>{item.questionLabel} · {item.scope === "choice" ? `${item.optionLabel} · ` : ""}{item.column}</span>
            </button>
          ))}
          {missing.length > 8 ? <p className="muted">{missing.length - 8} more missing files. Select highlighted questions to upload each one.</p> : null}
        </div>
      ) : null}
      {uploadedFiles.length ? (
        <div className="uploaded-resource-list">
          {uploadedFiles.map((fileName) => (
            <span key={fileName}>
              {fileName}
              <button
                className="inline-delete"
                disabled={locked || status.kind === "busy"}
                onClick={() => deleteWorkspaceAttachment(workspaceId, fileName)}
                aria-label={`Delete ${fileName}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QuestionResourcesBox({ workspace, requirements, status, locked = false, uploadWorkspaceAttachments, uploadWorkspaceResource, deleteWorkspaceAttachment }) {
  const workspaceId = workspace?.workspaceId || "";
  const missing = requirements.filter((item) => !item.uploaded);
  return (
    <div className="question-resources-box">
      <div className="section-head">
        <div>
          <h3>Required files</h3>
          <p>{missing.length ? "Upload the files referenced by this question." : "All files for this question are uploaded."}</p>
        </div>
        {missing.length ? (
          <label className="secondary small file-action">
            <Upload size={14} /> Upload Files
            <input
              type="file"
              multiple
	              disabled={locked || !workspaceId || status.kind === "busy"}
              onChange={(event) => uploadWorkspaceAttachments(workspaceId, event)}
            />
          </label>
        ) : null}
      </div>
      <div className="resource-list">
        {requirements.map((item) => (
          <div className={`resource-row ${item.uploaded ? "uploaded" : "missing"}`} key={item.id}>
            <div>
              <span className="resource-file">{item.fileName}</span>
              <small>
                {item.scope === "choice" ? `Choice: ${item.optionLabel || item.optionId} · ` : ""}
                XLS column: {item.column}
              </small>
            </div>
            {item.uploaded ? (
              <div className="resource-actions">
                <span className="resource-state">Uploaded</span>
                <label className="secondary small file-action">
                  <Upload size={14} /> Replace
                  <input
                    type="file"
	                    disabled={locked || !workspaceId || status.kind === "busy"}
                    onChange={(event) => uploadWorkspaceResource(workspaceId, item.fileName, event)}
                  />
                </label>
                <button
                  className="secondary small danger-action"
	                  disabled={locked || !workspaceId || status.kind === "busy"}
                  onClick={() => deleteWorkspaceAttachment(workspaceId, item.fileName)}
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            ) : (
              <label className="secondary small file-action">
                <Upload size={14} /> Upload
                <input
                  type="file"
	                  disabled={locked || !workspaceId || status.kind === "busy"}
                  onChange={(event) => uploadWorkspaceResource(workspaceId, item.fileName, event)}
                />
              </label>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function EntriesPanel({ form, entries, workspaceId, viewEntry, refreshEntries, status }) {
  const entryIds = useMemo(() => entries.map((entry) => String(entry.id || "")).filter(Boolean), [entries]);
  const entryIdKey = entryIds.join("|");
  const [selectedEntryIds, setSelectedEntryIds] = useState([]);
  const selectedEntrySet = useMemo(() => new Set(selectedEntryIds), [selectedEntryIds]);
  const selectedEntries = entries.filter((entry) => selectedEntrySet.has(String(entry.id || "")));
  const allSelected = entryIds.length > 0 && selectedEntryIds.length === entryIds.length;
  const csvHeaders = useMemo(() => entryCsvQuestions(form).map((question) => question.name), [form]);

  useEffect(() => {
    setSelectedEntryIds(entryIds);
  }, [entryIdKey]);

  function toggleEntry(entryId, checked) {
    setSelectedEntryIds((current) => checked
      ? [...new Set([...current, entryId])]
      : current.filter((id) => id !== entryId));
  }

  function downloadSelectedEntries() {
    if (!selectedEntries.length || !csvHeaders.length) return;
    const csv = entriesToCsv(form, selectedEntries);
    const fileName = safeDownloadName(`${form?.formId || form?.title || "icph_form"}_entries.csv`, "icph_entries.csv");
    downloadBlob(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }), fileName);
  }

  return (
    <div className="panel entries-panel">
      <div className="section-head">
        <h2>Entries</h2>
        <div className="section-actions">
          <span>{entries.length} submissions</span>
          {entries.length ? (
            <>
              <button className="secondary small" onClick={() => setSelectedEntryIds(entryIds)}>
                Select all
              </button>
              <button className="secondary small" onClick={() => setSelectedEntryIds([])}>
                Deselect all
              </button>
              <button className="primary small" disabled={!selectedEntries.length || !csvHeaders.length} onClick={downloadSelectedEntries}>
                <Download size={14} /> Download CSV
              </button>
            </>
          ) : null}
          <button className="secondary small" disabled={!workspaceId || status?.kind === "busy"} onClick={refreshEntries}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="muted">No local submissions yet.</p>
      ) : (
        <div className="entries-table">
          <label className="bulk-check-row">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(event) => setSelectedEntryIds(event.target.checked ? entryIds : [])}
            />
            <span>{selectedEntries.length}/{entries.length} selected</span>
          </label>
          {entries.slice().reverse().map((entry) => {
            const entryId = String(entry.id || "");
            return (
            <div className="entry-row" key={entry.id}>
              <label className="row-check">
                <input
                  type="checkbox"
                  checked={selectedEntrySet.has(entryId)}
                  onChange={(event) => toggleEntry(entryId, event.target.checked)}
                />
                <span className="sr-only">Select entry {entry.instanceName || entry.displayName || entry.id}</span>
              </label>
              <div>
                <span>{entry.instanceName || entry.displayName || entry.id}</span>
                <small>
                  {new Date(entry.submittedAt).toLocaleString()}
                  {entry.instanceName && entry.instanceName !== entry.id ? ` · ${entry.id}` : ""}
                </small>
              </div>
              <button className="secondary small" disabled={!workspaceId} onClick={() => viewEntry(workspaceId, entry.id)}>
                <ExternalLink size={14} /> View
              </button>
            </div>
          );})}
        </div>
      )}
    </div>
  );
}

function TerminologyPanel({ form, workspace, terminology = {}, status, runTerminologyExtraction, replaceTerminologyMapping, addTerminologyEntity, reviewIssue, locked = false }) {
  const questions = (Array.isArray(terminology.questions) ? terminology.questions : []).filter((question) => !isStructuralQuestion(question));
  const questionsWithEntities = questions.filter((question) => Array.isArray(question.entities) && question.entities.length > 0);
  const questionsWithoutEntities = questions.filter((question) => !Array.isArray(question.entities) || question.entities.length === 0);
  const entityCount = terminology.entityCount ?? questions.reduce((sum, question) => sum + (question.entities?.length || 0), 0);
  const running = terminology.status === "running";
  const complete = terminology.status === "complete";
  const reviewLocked = locked || hasPublishedForm(workspace);
  const progress = terminology.questionCount
    ? `${terminology.processedQuestionCount || 0}/${terminology.questionCount} questions`
    : `${questions.length} questions`;
  const [activeSelection, setActiveSelection] = useState(null);
  const [activeVocabulary, setActiveVocabulary] = useState("snomed");
  const [snomedQuery, setSnomedQuery] = useState("");
  const [snomedResults, setSnomedResults] = useState([]);
  const [snomedStatus, setSnomedStatus] = useState({ kind: "idle", message: "" });
  const [selectedTerminologyQuestionIds, setSelectedTerminologyQuestionIds] = useState([]);
  const [manualEntityQuestionId, setManualEntityQuestionId] = useState("");
  const [manualEntityText, setManualEntityText] = useState("");
  const [manualEntityStatus, setManualEntityStatus] = useState({ kind: "idle", message: "" });
  const selectableQuestionIds = useMemo(
    () => questions.map((question) => String(question.id || question.name)).filter(Boolean),
    [questions]
  );
  const manualEntityQuestion = useMemo(
    () => {
      if (!manualEntityQuestionId) return null;
      return questions.find((question) => String(question.id || question.name) === manualEntityQuestionId || String(question.name || "") === manualEntityQuestionId) || null;
    },
    [questions, manualEntityQuestionId]
  );
  const manualEntityUnmatchedWords = useMemo(
    () => manualEntityQuestion ? unmatchedManualEntityWords(manualEntityText, manualEntityQuestion, form) : [],
    [manualEntityText, manualEntityQuestion, form]
  );
  const activeQuestion = activeSelection
    ? questions.find((question) => String(question.id || question.name) === activeSelection.questionId)
    : null;
  const activeEntity = activeQuestion?.entities?.[activeSelection?.entityIndex] || null;
  const activeEntitySourceLabel = activeEntity ? entitySourceLabel(activeEntity) : "";
  const activeEntitySourceText = activeEntity ? entitySourceText(activeEntity) : "";

  useEffect(() => {
    setSelectedTerminologyQuestionIds((current) => {
      const valid = new Set(selectableQuestionIds);
      const kept = current.filter((id) => valid.has(id));
      return kept.length ? kept : selectableQuestionIds;
    });
  }, [selectableQuestionIds.join("|")]);

  useEffect(() => {
    if (!activeEntity) return;
    setActiveVocabulary(activeSelection?.vocabulary || vocabularyKey(activeEntity.terminology));
    setSnomedQuery(activeEntity.entity || activeEntity.originalEntity || activeEntity.term || "");
  }, [activeSelection?.questionId, activeSelection?.entityIndex, activeSelection?.vocabulary]);

  useEffect(() => {
    if (!activeEntity) {
      setSnomedResults([]);
      setSnomedStatus({ kind: "idle", message: "" });
      return undefined;
    }
    const query = snomedQuery.trim();
    if (!query) {
      setSnomedResults([]);
      setSnomedStatus({ kind: "idle", message: "" });
      return undefined;
    }
    const controller = new AbortController();
    const vocabulary = vocabularyOption(activeVocabulary);
    setSnomedStatus({ kind: "busy", message: `Searching ${vocabulary.label}...` });
    const timer = window.setTimeout(() => {
      requestJson(`/api/terminology/search?vocabulary=${encodeURIComponent(activeVocabulary)}&query=${encodeURIComponent(query)}&selectedCode=${encodeURIComponent(vocabularyKey(activeEntity.terminology) === activeVocabulary ? activeEntity.code || "" : "")}&limit=20`, {
        signal: controller.signal
      })
        .then((data) => {
          setSnomedResults(data.results || []);
          setSnomedStatus({ kind: "ok", message: `${data.results?.length || 0} ${vocabulary.label} result${data.results?.length === 1 ? "" : "s"}` });
        })
        .catch((error) => {
          if (error.name === "AbortError") return;
          setSnomedResults([]);
          setSnomedStatus({ kind: "error", message: error.message || `${vocabulary.label} search failed.` });
        });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeEntity?.entity, activeEntity?.code, activeEntity?.terminology, activeVocabulary, snomedQuery]);

  function openEntityReview(question, entity, entityIndex, vocabulary = vocabularyKey(entity.terminology)) {
    setActiveSelection({
      questionId: String(question.id || question.name),
      entityIndex,
      questionLabel: question.label || question.name || "Question",
      questionName: question.name || question.id || "",
      vocabulary
    });
    setActiveVocabulary(vocabulary);
    setSnomedQuery(entity.entity || entity.originalEntity || entity.term || "");
  }

  async function approveVocabularyResult(result) {
    if (reviewLocked) return;
    if (!activeSelection || !activeEntity) return;
    setSnomedStatus({ kind: "busy", message: "Saving approved vocabulary match..." });
    try {
      await replaceTerminologyMapping({
        questionId: activeSelection.questionId,
        entityIndex: activeSelection.entityIndex,
        replacement: result
      });
      setSnomedStatus({ kind: "ok", message: "Approved vocabulary match saved." });
    } catch (error) {
      setSnomedStatus({ kind: "error", message: error.message || "Could not save approved match." });
    }
  }

  async function removeVocabularyApproval(mapping) {
    if (reviewLocked) return;
    if (!activeSelection || !activeEntity) return;
    setSnomedStatus({ kind: "busy", message: "Removing approved match..." });
    try {
      await replaceTerminologyMapping({
        questionId: activeSelection.questionId,
        entityIndex: activeSelection.entityIndex,
        removeApprovedMapping: mapping
      });
      setSnomedStatus({ kind: "ok", message: "Approved match removed." });
    } catch (error) {
      setSnomedStatus({ kind: "error", message: error.message || "Could not remove approved match." });
    }
  }

  async function approveUnmapped() {
    if (reviewLocked) return;
    if (!activeSelection || !activeEntity) return;
    setSnomedStatus({ kind: "busy", message: "Confirming unmapped review..." });
    try {
      await replaceTerminologyMapping({
        questionId: activeSelection.questionId,
        entityIndex: activeSelection.entityIndex,
        approveUnmapped: true
      });
      setSnomedStatus({ kind: "ok", message: "Unmapped review confirmed." });
    } catch (error) {
      setSnomedStatus({ kind: "error", message: error.message || "Could not confirm unmapped review." });
    }
  }

  function openManualEntityDialog(question) {
    if (reviewLocked) return;
    if (isStructuralQuestion(question)) return;
    setManualEntityQuestionId(String(question.id || question.name));
    setManualEntityText("");
    setManualEntityStatus({ kind: "idle", message: "" });
  }

  function closeManualEntityDialog() {
    setManualEntityQuestionId("");
    setManualEntityText("");
    setManualEntityStatus({ kind: "idle", message: "" });
  }

  async function confirmManualEntity() {
    if (reviewLocked) return;
    if (!manualEntityQuestion) return;
    const entityText = manualEntityText.replace(/\s+/g, " ").trim();
    if (!entityText) {
      setManualEntityStatus({ kind: "error", message: "Enter the entity text to add." });
      return;
    }
    setManualEntityStatus({ kind: "busy", message: "Adding entity..." });
    try {
      const result = await addTerminologyEntity({
        questionId: String(manualEntityQuestion.id || manualEntityQuestion.name),
        entityText
      });
      const savedQuestion = result?.question || manualEntityQuestion;
      const entityIndex = Number.isFinite(result?.entityIndex) ? result.entityIndex : Math.max(0, (savedQuestion.entities || []).length - 1);
      const savedEntity = savedQuestion.entities?.[entityIndex];
      closeManualEntityDialog();
      if (savedEntity) {
        openEntityReview(savedQuestion, savedEntity, entityIndex, "snomed");
        setSnomedQuery(entityText);
      }
    } catch (error) {
      setManualEntityStatus({ kind: "error", message: error.message || "Could not add this entity." });
    }
  }

	  const reviewStats = terminologyReviewStats(terminology);
	  const activeVocabularyOption = vocabularyOption(activeVocabulary);
	  const activeApprovedMappings = approvedMappingsForEntity(activeEntity);
	  const activeCandidateMappings = candidateMappingsForEntity(activeEntity);
	  const allSelected = selectableQuestionIds.length > 0 && selectedTerminologyQuestionIds.length === selectableQuestionIds.length;
	  const selectedCount = selectedTerminologyQuestionIds.length;
	  const rerunLabel = running
	    ? "Running"
	    : complete
	      ? selectedCount === selectableQuestionIds.length ? "Run Again for All" : selectedCount ? "Run Again for Selected" : "Select Questions to Rerun"
	      : "Run Terminology";

  return (
    <section className="publish-stack terminology-stack">
      <div className="panel publish-summary terminology-summary">
        <StageBadge stage={workspace?.pipelineStage || (hasPublishedForm(workspace) ? "Publishing" : "Building")} />
        <h2>Terminology</h2>
        <p>
          {reviewLocked
            ? "Terminology review is locked because this form has moved to Publish."
            : "Question text is processed for form-definition entities before publishing. Review every mapped or unmapped vocabulary item to unlock publishing."}
        </p>
        <div className="mini-metrics">
          <span>{terminology.status || "not_started"}</span>
          <span>{progress}</span>
          <span>{entityCount} entities</span>
          <span>{reviewStats.reviewed}/{reviewStats.total} reviewed</span>
          {questionsWithoutEntities.length ? <span>{questionsWithoutEntities.length} with no extracted entities</span> : null}
        </div>
	        <div className="stage-actions">
	          <button
	            className="secondary"
	            disabled={reviewLocked || status.kind === "busy" || running || (complete && !selectedCount)}
	            onClick={() => runTerminologyExtraction(selectedTerminologyQuestionIds)}
	          >
	            <Forward size={18} /> {rerunLabel}
	          </button>
	        </div>
	        {terminology.error ? <p className="terminology-error">{terminology.error}</p> : null}
	        {reviewIssue ? <p className="terminology-error">{reviewIssue}</p> : null}
      </div>

      <div className="panel terminology-panel">
	        <div className="section-head">
	          <div>
	            <h2>Question Entities</h2>
	            <p>{selectedCount}/{selectableQuestionIds.length} selected for rerun</p>
              <div className="entity-source-legend" aria-label="Entity source legend">
                {ENTITY_SOURCE_LEGEND.filter((item) => item.key !== "unknown").map((item) => (
                  <span key={item.key}><b aria-hidden="true">{item.emoji}</b> {item.label}</span>
                ))}
              </div>
	          </div>
	          <div className="section-actions">
	            <button className="secondary small" type="button" disabled={reviewLocked || allSelected || !selectableQuestionIds.length} onClick={() => setSelectedTerminologyQuestionIds(selectableQuestionIds)}>
	              Select All
	            </button>
	            <button className="secondary small" type="button" disabled={reviewLocked || !selectedCount} onClick={() => setSelectedTerminologyQuestionIds([])}>
	              Deselect All
	            </button>
	            <span>{entityCount} entities</span>
	          </div>
	        </div>
        {questions.length === 0 ? (
          <div className="empty-state">
            <FileText size={32} />
            <p>{running ? "Terminology extraction is starting..." : "No terminology extraction output yet."}</p>
          </div>
        ) : (
          <div className="terminology-workbench">
            <div className="terminology-list">
              {questionsWithEntities.map((question) => (
	                <article className={`terminology-row ${question.status || ""}`} key={question.id || question.name}>
	                  <div className="terminology-question">
	                    <label className="terminology-question-check">
	                      <input
	                        type="checkbox"
                          disabled={reviewLocked}
	                        checked={selectedTerminologyQuestionIds.includes(String(question.id || question.name))}
	                        onChange={(event) => {
	                          const id = String(question.id || question.name);
	                          setSelectedTerminologyQuestionIds((current) => event.target.checked
	                            ? [...new Set([...current, id])]
	                            : current.filter((item) => item !== id));
	                        }}
	                      />
	                      <span>
	                        <h3>{question.label || question.name}</h3>
	                        <p className="mono">{question.name || question.id}</p>
	                      </span>
	                    </label>
                    <div className="card-metrics">
                      <span>{question.type}</span>
                      <span>{question.status || "complete"}</span>
                      <span>{question.entities?.length || 0} entities</span>
                    </div>
                  </div>
                  <button
                    className="link-button terminology-add-entity"
                    type="button"
                    disabled={reviewLocked}
                    onClick={() => openManualEntityDialog(question)}
                  >
                    add another entity
                  </button>
	                  {question.entities?.length ? (
	                    <div className="entity-list">
		                      {question.entities.map((entity, index) => {
		                        const questionId = String(question.id || question.name);
		                        const active = activeSelection?.questionId === questionId && activeSelection?.entityIndex === index;
		                        const selectedVocabulary = active ? activeVocabulary : vocabularyKey(entity.terminology);
		                        const approvedMappings = approvedMappingsForEntity(entity);
		                        const reviewed = entityReviewComplete(entity);
                            const sourceLegend = entitySourceLegendItem(entity);
		                        return (
		                          <div
		                            className={`entity-card ${active ? "active" : ""} ${reviewed ? "validated" : ""}`}
		                            key={`${question.id || question.name}_${index}`}
		                          >
                                <div className="entity-card-meta">
                                  <span className={`entity-card-status ${reviewed ? "reviewed" : "pending"}`}>
                                    {reviewed ? "reviewed" : "pending"}
                                  </span>
                                  <span className="entity-source-emoji" title={sourceLegend.label} aria-label={sourceLegend.label}>
                                    {sourceLegend.emoji}
                                  </span>
                                </div>
		                            <button
		                              type="button"
	                              className="entity-card-main"
	                              onClick={() => openEntityReview(question, entity, index, selectedVocabulary)}
		                            >
		                              <strong>{entity.entity}</strong>
		                              {entity.term ? <em>{entity.term}</em> : null}
		                            </button>
                                {approvedMappings.length ? (
                                  <div className="entity-approved-summary" aria-label="Approved vocabulary matches">
                                    {approvedMappings.slice(0, 3).map((mapping) => (
                                      <span key={approvedMappingKey(mapping)}>
                                        <strong>{mapping.vocabularyLabel}</strong>
                                        {mapping.display || mapping.term ? `: ${mapping.display || mapping.term}` : ""}
                                        {mapping.code ? ` (${mapping.code})` : ""}
                                      </span>
                                    ))}
                                    {approvedMappings.length > 3 ? <span>+{approvedMappings.length - 3} more approved</span> : null}
                                  </div>
                                ) : null}
		                          </div>
	                        );
	                      })}
	                    </div>
	                  ) : (
                    <div className="empty-entity-list">
                      <p>No entities listed for this question.</p>
                    </div>
                  )}
                  {question.warnings?.length ? (
                    <details className="terminology-warnings">
                      <summary>{question.warnings.length} warning{question.warnings.length === 1 ? "" : "s"}</summary>
                      <pre>{JSON.stringify(question.warnings, null, 2)}</pre>
                    </details>
                  ) : null}
                </article>
              ))}
              {questionsWithoutEntities.length ? (
                <details className="terminology-zero-section">
                  <summary>
                    <span>Questions with no extracted entities</span>
                    <em>{questionsWithoutEntities.length} question{questionsWithoutEntities.length === 1 ? "" : "s"}</em>
                  </summary>
                  <div className="terminology-zero-list">
                    {questionsWithoutEntities.map((question) => {
                      const questionId = String(question.id || question.name);
                      return (
                        <article className={`terminology-row zero-entity ${question.status || ""}`} key={question.id || question.name}>
                          <div className="terminology-question">
                            <label className="terminology-question-check">
                              <input
                                type="checkbox"
                                disabled={reviewLocked}
                                checked={selectedTerminologyQuestionIds.includes(questionId)}
                                onChange={(event) => {
                                  setSelectedTerminologyQuestionIds((current) => event.target.checked
                                    ? [...new Set([...current, questionId])]
                                    : current.filter((item) => item !== questionId));
                                }}
                              />
                              <span>
                                <h3>{question.label || question.name}</h3>
                                <p className="mono">{question.name || question.id}</p>
                              </span>
                            </label>
                            <div className="card-metrics">
                              <span>{question.type}</span>
                              <span>{question.status || "complete"}</span>
                              <span>0 entities</span>
                            </div>
                          </div>
                          <p className="zero-entity-note">No terminology entities were found automatically for this question.</p>
                          <button
                            className="link-button terminology-add-entity"
                            type="button"
                            disabled={reviewLocked}
                            onClick={() => openManualEntityDialog(question)}
                          >
                            add another entity
                          </button>
                          {question.warnings?.length ? (
                            <details className="terminology-warnings">
                              <summary>{question.warnings.length} warning{question.warnings.length === 1 ? "" : "s"}</summary>
                              <pre>{JSON.stringify(question.warnings, null, 2)}</pre>
                            </details>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                </details>
              ) : null}
            </div>
            <aside className="terminology-review-panel">
              {activeEntity ? (
                <>
                  <div className="terminology-review-head">
                    <div>
                      <span>Vocabulary Review</span>
                      <h3>{activeEntity.entity}</h3>
                      <p>{activeSelection.questionLabel}</p>
                    </div>
                    <button className="icon-button" type="button" onClick={() => setActiveSelection(null)} aria-label="Close vocabulary review">
                      <X size={18} />
                    </button>
                  </div>
                  <div className="entity-source-box">
                    <span>Decomposed from</span>
                    <strong>{activeEntitySourceLabel || "Source not recorded"}</strong>
                    <p>{activeEntitySourceText || "Rerun terminology extraction to populate source provenance for older results."}</p>
                  </div>
	                  <div className="current-snomed">
	                    <div className="current-selection-head">
	                      <span>Mapper suggestion</span>
	                    </div>
	                    {activeEntity.code && activeEntity.validationStatus !== "auto_approved" ? (
	                      <>
	                        <strong>{activeEntity.term || activeEntity.entity}</strong>
	                        <p>{activeEntity.terminology || activeVocabularyOption.label}: {activeEntity.code}</p>
	                      </>
	                    ) : activeEntity.validationStatus === "auto_approved" ? (
                        <p>Suggested match found, but it still needs admin review.</p>
	                    ) : (
	                      <p>{activeEntity.validationStatus === "unmapped_confirmed" ? "Unmapped confirmed" : "No mapper suggestion"}</p>
	                    )}
                      <div className={`unmapped-review-action ${activeEntity.validationStatus === "unmapped_confirmed" ? "confirmed" : ""}`}>
                        <button
                          className="secondary small"
                          type="button"
                          disabled={reviewLocked || snomedStatus.kind === "busy" || activeEntity.validationStatus === "unmapped_confirmed"}
                          onClick={approveUnmapped}
                        >
                          {activeEntity.validationStatus === "unmapped_confirmed" ? <Check size={14} /> : <X size={14} />}
                          {activeEntity.validationStatus === "unmapped_confirmed" ? "Marked unmapped" : "Leave unmapped"}
                        </button>
                        {activeEntity.validationStatus === "unmapped_confirmed" ? (
                          <p>This entity will not add vocabulary coding to FHIR.</p>
                        ) : (
                          <p>Use this when the mapper suggestion is wrong or no vocabulary code applies.</p>
                        )}
                      </div>
	                  </div>
	                  <div className="approved-mappings-box">
	                    <div className="current-selection-head">
	                      <span>Approved matches</span>
	                      <strong>{activeApprovedMappings.length}</strong>
	                    </div>
	                    {activeApprovedMappings.length ? (
	                      <div className="approved-mapping-list">
	                        {activeApprovedMappings.map((mapping) => (
	                          <div className="approved-mapping" key={approvedMappingKey(mapping)}>
	                            <div>
	                              <strong>{mapping.display || mapping.term}</strong>
	                              <p>{mapping.vocabularyLabel}: {mapping.code}</p>
	                            </div>
	                            <button
	                              className="icon-button"
	                              type="button"
                                disabled={reviewLocked || snomedStatus.kind === "busy"}
	                              onClick={() => removeVocabularyApproval(mapping)}
	                              aria-label={`Remove ${mapping.vocabularyLabel} ${mapping.code}`}
	                              title="Remove approved match"
	                            >
	                              <X size={16} />
	                            </button>
	                          </div>
	                        ))}
	                      </div>
	                    ) : activeEntity.validationStatus === "unmapped_confirmed" ? (
	                      <p>No vocabulary code approved for this term.</p>
	                    ) : (
	                      <p>Approve one or more matches below, or confirm unmapped when no code applies.</p>
	                    )}
	                  </div>
                  {activeCandidateMappings.length ? (
                    <div className="brute-candidates-box">
                      <h2>High probability candidates</h2>
                      <div className="brute-candidate-list">
                        {activeCandidateMappings.slice(0, 10).map((mapping) => (
                          <div className="brute-candidate" key={approvedMappingKey(mapping)}>
                            <div>
                              <strong>{mapping.display || mapping.term}</strong>
                              <p>{mapping.vocabularyLabel}: {mapping.code}</p>
                              {mapping.confidence || mapping.matchKind || mapping.score ? (
                                <span>{[mapping.confidence, mapping.matchKind, mapping.score ? `score ${mapping.score}` : ""].filter(Boolean).join(" · ")}</span>
                              ) : null}
                            </div>
                            <button
                              className="icon-button"
                              type="button"
                              disabled={reviewLocked || snomedStatus.kind === "busy"}
                              onClick={() => approveVocabularyResult(mapping)}
                              aria-label={`Approve ${mapping.vocabularyLabel} ${mapping.code}`}
                              title="Approve this high probability candidate"
                            >
                              <span className="result-empty-box" aria-hidden="true" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="search-vocabulary-section">
                    <h2>Search Vocabulary</h2>
                    <label className="snomed-search-box">
                      <span>Vocabulary</span>
                      <select value={activeVocabulary} disabled={reviewLocked} onChange={(event) => setActiveVocabulary(event.target.value)}>
                        {VOCABULARY_OPTIONS.map((option) => (
                          <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                      </select>
                      <div>
                        <Search size={17} />
                        <input value={snomedQuery} disabled={reviewLocked} onChange={(event) => setSnomedQuery(event.target.value)} />
                      </div>
                    </label>
                  </div>
                  {snomedStatus.message ? (
                    <p className={`snomed-status ${snomedStatus.kind}`}>{snomedStatus.message}</p>
                  ) : null}
	                  <div className="snomed-result-list">
	                    {snomedResults.length ? snomedResults.map((result) => {
	                      const resultVocabulary = result.vocabularyLabel || activeVocabularyOption.label;
	                      const resultMapping = normalizeApprovedMapping({
	                        ...result,
	                        vocabulary: result.vocabulary || activeVocabulary,
	                        vocabularyLabel: resultVocabulary
	                      });
	                      const approved = resultMapping && activeApprovedMappings.some((mapping) => approvedMappingKey(mapping) === approvedMappingKey(resultMapping));
	                      return (
	                        <div className={`snomed-result ${approved ? "selected" : ""}`} key={`${activeVocabulary}_${result.code}`}>
	                          <div>
	                            <strong>{result.display}</strong>
	                            <p>{result.fsn}</p>
	                            <span>{approved ? "Approved: " : ""}{resultVocabulary}: {result.code}</span>
	                          </div>
	                          <button
	                            className="icon-button"
	                            type="button"
                              disabled={reviewLocked || snomedStatus.kind === "busy"}
	                            onClick={() => approveVocabularyResult({ ...result, vocabulary: activeVocabulary, vocabularyLabel: resultVocabulary })}
	                            aria-label={`Use ${result.display}`}
	                            title={approved ? "Already approved" : "Approve this vocabulary match"}
	                          >
	                            {approved ? <Check size={18} /> : <span className="result-empty-box" aria-hidden="true" />}
	                          </button>
                        </div>
                      );
                    }) : (
                      <div className="empty-state compact">
                        <Search size={24} />
                        <p>{snomedStatus.kind === "busy" ? "Searching..." : `No ${activeVocabularyOption.label} results to show.`}</p>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="empty-state terminology-review-empty">
                  <Search size={32} />
                  <p>Select any mapped or unmapped entity to review vocabulary candidates.</p>
                </div>
              )}
            </aside>
          </div>
        )}
      </div>
      {manualEntityQuestion ? (
        <ManualEntityModal
          question={manualEntityQuestion}
          form={form}
          value={manualEntityText}
          unmatchedWords={manualEntityUnmatchedWords}
          status={manualEntityStatus}
          onChange={setManualEntityText}
          onCancel={closeManualEntityDialog}
          onConfirm={confirmManualEntity}
        />
      ) : null}
    </section>
  );
}

function ManualEntityModal({ question, form, value, unmatchedWords = [], status, onChange, onCancel, onConfirm }) {
  const busy = status?.kind === "busy";
  const details = manualEntityQuestionDetails(question, form);
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="link-modal manual-entity-modal" role="dialog" aria-modal="true" aria-label="Add terminology entity">
        <div className="modal-head">
          <div>
            <h2>Add another entity</h2>
            <p>{question.label || question.name || "Question"}</p>
          </div>
          <button className="icon-button" type="button" onClick={onCancel} aria-label="Close add entity dialog">
            <X size={18} />
          </button>
        </div>

        <label className="manual-entity-input">
          <span>Entity words to map</span>
          <input
            value={value}
            disabled={busy}
            autoFocus
            onChange={(event) => onChange(event.target.value)}
            placeholder="Example: pregnancy"
          />
        </label>

        {unmatchedWords.length ? (
          <div className="manual-entity-warning">
            <AlertCircle size={18} />
            <p>
              <strong>{unmatchedWords.join(", ")}</strong> {unmatchedWords.length === 1 ? "was" : "were"} not found in the question or question options. Are you sure you want to proceed extracting this entity?
            </p>
          </div>
        ) : value.trim() ? (
          <div className="manual-entity-ok">
            <Check size={18} />
            <p>All words were found in the question text or options.</p>
          </div>
        ) : null}

        {status?.message ? <p className={`snomed-status ${status.kind}`}>{status.message}</p> : null}

        <div className="manual-entity-source">
          <span>Question details</span>
          {details.length ? (
            <dl>
              {details.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>No question details available.</p>
          )}
        </div>

        <div className="modal-actions">
          <button className="secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="primary" type="button" disabled={busy || !value.trim()} onClick={onConfirm}>
            <Plus size={16} /> Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

function QuestionList({ form, resourceRequirements = [], locked, selectedId, setSelectedId, setDraggedId, moveQuestion, duplicateQuestion, removeQuestion }) {
  const resourceSummary = resourceRequirements.reduce((map, item) => {
    const current = map.get(item.questionId) || { total: 0, missing: 0 };
    current.total += 1;
    if (!item.uploaded) current.missing += 1;
    map.set(item.questionId, current);
    return map;
  }, new Map());
  return (
    <div className="question-list">
      <div className="section-head">
        <h2>Survey</h2>
        <span>{locked ? `${form.questions.length} questions · locked` : `${form.questions.length} questions`}</span>
      </div>
      {form.questions.length === 0 ? (
        <div className="empty-state">
          <ClipboardList size={32} />
          <p>{locked ? "No questions in this form." : "Add question types from the left panel."}</p>
        </div>
      ) : (
        form.questions.map((question, index) => (
          (() => {
            const resources = resourceSummary.get(question.id);
            return (
          <article
            key={question.id}
            className={`question-row ${selectedId === question.id ? "selected" : ""} ${locked ? "locked" : ""} ${resources?.missing ? "needs-resources" : resources?.total ? "has-resources" : ""}`}
            draggable={!locked}
            onDragStart={() => { if (!locked) setDraggedId(question.id); }}
            onDragOver={(event) => { if (!locked) event.preventDefault(); }}
            onDrop={() => { if (!locked) moveQuestion(question.id); }}
            onClick={() => setSelectedId(question.id)}
          >
            <GripVertical className="drag-handle" size={18} />
            <div className="question-index">{index + 1}</div>
            <div className="question-main">
              <div className="question-label">{question.label || "Untitled question"}</div>
              <div className="question-meta">
                <span>{question.type}</span>
                <span>{question.name}</span>
                {question.required ? <span>required</span> : null}
                {!question.required && question.requiredExpression ? <span>conditional required</span> : null}
                {question.readOnly || question.type === "calculate" ? <span className="state-chip readonly">read only</span> : null}
                {!question.readOnly && question.type !== "calculate" && question.readOnlyExpression ? <span className="state-chip readonly">conditional read only</span> : null}
                {question.calculation ? <span className="state-chip calculation">calculation</span> : null}
                {question.type === "timer" ? <span className="state-chip timer">{normalizeTimerConfig(question.timerConfig).mode.replace(/_/g, " ")}</span> : null}
                {resources?.missing ? <span className="resource-chip missing">{resources.missing} files needed</span> : resources?.total ? <span className="resource-chip uploaded">files ready</span> : null}
              </div>
            </div>
            <button className="icon-button" disabled={locked} onClick={(event) => { event.stopPropagation(); duplicateQuestion(question); }}>
              <Copy size={16} />
            </button>
            <button className="icon-button danger" disabled={locked} onClick={(event) => { event.stopPropagation(); removeQuestion(question.id); }}>
              <Trash2 size={16} />
            </button>
          </article>
            );
          })()
        ))
      )}
    </div>
  );
}

function ValidationPanel({ issues }) {
  return (
    <div className="panel validation">
      <h2>Validation</h2>
      {issues.length === 0 ? (
        <p className="success-text">No structural issues detected.</p>
      ) : (
        <ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
      )}
    </div>
  );
}

function fhirBundleKey(item, index) {
  return String(item?.bundlePath || item?.fileName || item?.patientId || `bundle_${index}`);
}

function FhirPanel({ fhirBundles, form }) {
  const selectableBundles = fhirBundles
    .map((item, index) => ({ item, key: fhirBundleKey(item, index) }))
    .filter(({ item }) => item?.bundle && !item?.error);
  const selectableKeys = selectableBundles.map(({ key }) => key);
  const selectableKeyText = selectableKeys.join("|");
  const [selectedBundleKeys, setSelectedBundleKeys] = useState([]);
  const selectedKeySet = useMemo(() => new Set(selectedBundleKeys), [selectedBundleKeys]);
  const selectedBundles = selectableBundles.filter(({ key }) => selectedKeySet.has(key));
  const allSelected = selectableKeys.length > 0 && selectedBundleKeys.length === selectableKeys.length;

  useEffect(() => {
    setSelectedBundleKeys(selectableKeys);
  }, [selectableKeyText]);

  function toggleBundle(bundleKey, checked) {
    setSelectedBundleKeys((current) => checked
      ? [...new Set([...current, bundleKey])]
      : current.filter((key) => key !== bundleKey));
  }

  function bundleDownloadName(item, index = 0) {
    return safeDownloadName(
      item.fileName || `${item.patientId || `patient_${index + 1}`}_fhir_bundle.json`,
      `patient_${index + 1}_fhir_bundle.json`
    );
  }

  function downloadSelectedBundles() {
    if (!selectedBundles.length) return;
    const files = selectedBundles.map(({ item }, index) => ({
      name: bundleDownloadName(item, index),
      text: JSON.stringify(item.bundle || {}, null, 2) + "\n"
    }));
    if (files.length === 1) {
      downloadBlob(new Blob([files[0].text], { type: "application/fhir+json;charset=utf-8" }), files[0].name);
      return;
    }
    const zipName = safeDownloadName(`${form?.formId || form?.title || "icph_form"}_fhir_bundles.zip`, "icph_fhir_bundles.zip");
    downloadBlob(zipBlob(files), zipName);
  }

  if (!fhirBundles.length) return null;
  return (
    <div className="panel fhir-panel">
      <div className="section-head">
        <h2>FHIR Bundles</h2>
        <div className="section-actions">
          <span>{fhirBundles.length} patients</span>
          {selectableKeys.length ? (
            <>
              <button className="secondary small" onClick={() => setSelectedBundleKeys(selectableKeys)}>
                Select all
              </button>
              <button className="secondary small" onClick={() => setSelectedBundleKeys([])}>
                Deselect all
              </button>
              <button className="primary small" disabled={!selectedBundles.length} onClick={downloadSelectedBundles}>
                <Download size={14} /> Download JSON
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="fhir-list">
        {selectableKeys.length ? (
          <label className="bulk-check-row">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(event) => setSelectedBundleKeys(event.target.checked ? selectableKeys : [])}
            />
            <span>{selectedBundles.length}/{selectableKeys.length} selected</span>
          </label>
        ) : null}
        {fhirBundles.map((item, index) => {
          const bundleKey = fhirBundleKey(item, index);
          const selectable = Boolean(item.bundle && !item.error);
          return (
          <details className="fhir-bundle" key={bundleKey}>
            <summary>
              <input
                type="checkbox"
                disabled={!selectable}
                checked={selectable && selectedKeySet.has(bundleKey)}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => toggleBundle(bundleKey, event.target.checked)}
                aria-label={`Select FHIR bundle for ${item.patientId || item.fileName}`}
              />
              <FileJson size={18} />
              <span>{item.patientId}</span>
              <em>{item.entryCount} resources</em>
            </summary>
            <p className="mono">{item.bundlePath}</p>
            {item.error ? (
              <p className="muted">{item.error}</p>
            ) : (
              <pre>{JSON.stringify(item.bundle || {}, null, 2)}</pre>
            )}
          </details>
        );})}
      </div>
    </div>
  );
}

function PreviewPanel({ form, collapsible = false }) {
  const previewQuestions = visibleQuestions(form, {});
  const content = (
    <>
      {previewQuestions.slice(0, 5).map((question) => (
        <PreviewField key={question.id} question={question} />
      ))}
      {form.questions.length > previewQuestions.length ? (
        <p className="muted">{form.questions.length - previewQuestions.length} conditional questions hidden in this preview.</p>
      ) : null}
    </>
  );
  if (collapsible) {
    return (
      <details className="panel preview preview-collapsible" open>
        <summary>
          <h2>Preview</h2>
          <span>{previewQuestions.length} visible</span>
        </summary>
        <div className="preview-body">{content}</div>
      </details>
    );
  }
  return (
    <div className="panel preview">
      <h2>Preview</h2>
      {content}
    </div>
  );
}

function PreviewField({ question, value = "", onChange = () => {}, forceDisabled = false }) {
  const disabled = Boolean(forceDisabled || question.readOnly || question.calculation);
  const calculated = Boolean(question.calculation);
  const hint = String(question.hint || "").trim();
  const hintNode = hint ? <small className="preview-hint">{hint}</small> : null;
  if (question.type === "select_one") {
    return (
      <label className="preview-field">
        <span>{question.label}{calculated ? <em> calculated</em> : null}</span>
        {hintNode}
        <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose...</option>
          {question.options?.map((option) => <option key={option.id || option.name} value={option.name}>{option.label}</option>)}
        </select>
      </label>
    );
  }
  if (question.type === "select_multiple" || question.type === "rank") {
    const selected = new Set(String(value || "").split(" ").filter(Boolean));
    return (
      <div className="preview-field">
        <span>{question.label}</span>
        {hintNode}
        <div className="preview-options">
          {question.options?.map((option) => (
            <label key={option.id || option.name}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={selected.has(option.name)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(option.name);
                  else next.delete(option.name);
                  onChange([...next].join(" "));
                }}
              />
              {" "}{option.label}
            </label>
          ))}
        </div>
      </div>
    );
  }
  if (question.type === "note") {
    return <div className="preview-field note-field"><span>{question.label}</span>{hintNode}</div>;
  }
  if (question.type === "calculate") {
    return null;
  }
  if (["image", "audio", "video", "file"].includes(question.type) && !forceDisabled) {
    return (
      <label className="preview-field">
        <span>{question.label}</span>
        {hintNode}
        <input type="file" disabled={disabled} onChange={(event) => onChange(event.target.files?.[0]?.name || "")} />
      </label>
    );
  }
  if (question.type === "acknowledge") {
    return (
      <label className="preview-field acknowledge-field">
        <span>{question.label}</span>
        {hintNode}
        <label>
          <input type="checkbox" disabled={disabled} checked={String(value) === "OK"} onChange={(event) => onChange(event.target.checked ? "OK" : "")} />
          {" "}Acknowledge
        </label>
      </label>
    );
  }
  if (question.type === "start-geopoint") {
    return (
      <div className="preview-field location-preview-field">
        <span>{question.label}</span>
        {hintNode}
        <p>Captured automatically when the ODK form opens.</p>
        {value ? <code>{value}</code> : null}
      </div>
    );
  }
  if (question.type === "geopoint") {
    const parts = String(value || "").split(/\s+/);
    const [lat = "", lon = "", alt = "", acc = ""] = parts;
    const commit = (next) => onChange([next.lat, next.lon, next.alt, next.acc].filter((item, index) => index < 2 || String(item || "").trim()).join(" "));
    const captureCurrentLocation = () => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition((position) => {
        const coords = position.coords;
        commit({
          lat: String(coords.latitude),
          lon: String(coords.longitude),
          alt: Number.isFinite(coords.altitude) ? String(coords.altitude) : "0",
          acc: Number.isFinite(coords.accuracy) ? String(coords.accuracy) : ""
        });
      });
    };
    return (
      <div className="preview-field location-preview-field">
        <span>{question.label}</span>
        {hintNode}
        <div className="geo-point-grid">
          <input type="number" value={lat} disabled={disabled} placeholder="Latitude" onChange={(event) => commit({ lat: event.target.value, lon, alt, acc })} />
          <input type="number" value={lon} disabled={disabled} placeholder="Longitude" onChange={(event) => commit({ lat, lon: event.target.value, alt, acc })} />
          <input type="number" value={alt} disabled={disabled} placeholder="Altitude" onChange={(event) => commit({ lat, lon, alt: event.target.value, acc })} />
          <input type="number" value={acc} disabled={disabled} placeholder="Accuracy" onChange={(event) => commit({ lat, lon, alt, acc: event.target.value })} />
        </div>
        {!disabled && !forceDisabled ? (
          <button type="button" className="secondary small" onClick={captureCurrentLocation}>
            <MapPin size={14} /> Use Current Location
          </button>
        ) : null}
      </div>
    );
  }
  if (question.type === "geotrace" || question.type === "geoshape") {
    return (
      <label className="preview-field location-preview-field">
        <span>{question.label}</span>
        {hintNode}
        <textarea
          value={value}
          disabled={disabled}
          placeholder={question.type === "geotrace" ? "lat lon alt acc; lat lon alt acc" : "lat lon alt acc; lat lon alt acc; lat lon alt acc; lat lon alt acc"}
          onChange={(event) => onChange(event.target.value)}
        />
        <small>{question.type === "geotrace" ? "A trace is saved as ordered GPS points." : "A shape is saved as a closed polygon of GPS points."}</small>
      </label>
    );
  }
  const inputType = forceDisabled
    ? "text"
    : question.type === "date"
      ? "date"
      : question.type === "time"
        ? "time"
      : question.type === "dateTime"
        ? "datetime-local"
        : question.type === "integer" || question.type === "decimal" || question.type === "range"
          ? "number"
          : "text";
  return (
    <label className="preview-field">
      <span>{question.label}</span>
      {hintNode}
      <input
        type={inputType}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function localTimestamp(date = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

function timerQuestionKey(question = {}) {
  return String(question.id || question.name || "");
}

function durationSeconds(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return "";
  return String(Math.round((endMs - startMs) / 1000));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setXmlLeafValue(xml, name, value) {
  const text = String(value || "");
  if (!text) return xml;
  const safeName = escapeRegExp(name);
  const escaped = xmlEscape(text);
  const fullTag = new RegExp(`<(${safeName})(\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>`);
  if (fullTag.test(xml)) {
    return xml.replace(fullTag, (_match, tag, attrs = "") => `<${tag}${attrs}>${escaped}</${tag}>`);
  }
  const selfClosing = new RegExp(`<(${safeName})(\\s[^>]*)?\\s*\\/>`);
  if (selfClosing.test(xml)) {
    return xml.replace(selfClosing, (_match, tag, attrs = "") => `<${tag}${attrs}>${escaped}</${tag}>`);
  }
  const rootClose = xml.match(/<\/([A-Za-z_][\w:.-]*)>\s*$/);
  return rootClose ? xml.replace(rootClose[0], `<${name}>${escaped}</${name}>${rootClose[0]}`) : xml;
}

function injectTimerValuesIntoXml(instanceXml, values = {}) {
  return Object.entries(values).reduce((xml, [name, value]) => setXmlLeafValue(xml, name, value), instanceXml);
}

function useTimerController(form, eventRootRef) {
  const timers = useMemo(() => timerQuestions(form), [form]);
  const timersKey = useMemo(() => timers.map((timer) => `${timerQuestionKey(timer)}:${timer.name}:${normalizeTimerConfig(timer.timerConfig).mode}`).join("|"), [timers]);
  const valuesRef = useRef({});
  const [values, setValues] = useState({});

  function updateTimer(question, patch) {
    const key = timerQuestionKey(question);
    const nextForTimer = { ...(valuesRef.current[key] || {}), ...patch };
    const names = timerFieldNames(question);
    if (nextForTimer.start && nextForTimer.end) {
      nextForTimer.duration = durationSeconds(nextForTimer.start, nextForTimer.end);
    }
    valuesRef.current = {
      ...valuesRef.current,
      [key]: nextForTimer
    };
    setValues(valuesRef.current);
    return { names, state: nextForTimer };
  }

  function startTimer(question) {
    const current = valuesRef.current[timerQuestionKey(question)] || {};
    if (current.start) return;
    updateTimer(question, { start: localTimestamp(), end: "", duration: "" });
  }

  function stopTimer(question) {
    const current = valuesRef.current[timerQuestionKey(question)] || {};
    if (!current.start || current.end) return;
    updateTimer(question, { end: localTimestamp() });
  }

  useEffect(() => {
    const initialValues = {};
    const now = localTimestamp();
    for (const timer of timers) {
      const config = normalizeTimerConfig(timer.timerConfig);
      if (config.mode === "open_submit") {
        initialValues[timerQuestionKey(timer)] = { start: now, end: "", duration: "" };
      }
    }
    valuesRef.current = initialValues;
    setValues(initialValues);
  }, [timersKey]);

  useEffect(() => {
    const root = eventRootRef?.current;
    if (!root || !timers.length) return undefined;
    const firstInputTimers = timers.filter((timer) => normalizeTimerConfig(timer.timerConfig).mode === "first_input_submit");
    if (!firstInputTimers.length) return undefined;
    const handleFirstInput = (event) => {
      const target = event.target;
      if (!target?.closest?.("input, textarea, select")) return;
      firstInputTimers.forEach(startTimer);
    };
    root.addEventListener("input", handleFirstInput, true);
    root.addEventListener("change", handleFirstInput, true);
    return () => {
      root.removeEventListener("input", handleFirstInput, true);
      root.removeEventListener("change", handleFirstInput, true);
    };
  }, [eventRootRef, timersKey]);

  function finalizeTimers() {
    if (!timers.length) return {};
    const now = localTimestamp();
    const nextValues = { ...valuesRef.current };
    const output = {};
    for (const timer of timers) {
      const key = timerQuestionKey(timer);
      const config = normalizeTimerConfig(timer.timerConfig);
      const state = { ...(nextValues[key] || {}) };
      if (config.mode === "open_submit" && !state.start) state.start = now;
      if (config.mode === "first_input_submit" && !state.start) state.start = now;
      if (config.mode !== "manual" || state.start) {
        if (!state.end) state.end = now;
      }
      if (state.start && state.end) state.duration = durationSeconds(state.start, state.end);
      nextValues[key] = state;
      const names = timerFieldNames(timer);
      if (state.start) output[names.start] = state.start;
      if (state.end) output[names.end] = state.end;
      if (state.duration) output[names.duration] = state.duration;
    }
    valuesRef.current = nextValues;
    setValues(nextValues);
    return output;
  }

  return { timers, values, startTimer, stopTimer, finalizeTimers };
}

function TimerRespondentPanel({ timers, values, startTimer, stopTimer }) {
  const visibleTimers = timers.filter((timer) => normalizeTimerConfig(timer.timerConfig).showToRespondent);
  if (!visibleTimers.length) return null;
  return (
    <div className="respondent-timer-stack">
      {visibleTimers.map((timer) => {
        const config = normalizeTimerConfig(timer.timerConfig);
        const state = values[timerQuestionKey(timer)] || {};
        return (
          <section className="respondent-timer-card" key={timerQuestionKey(timer)}>
            <div>
              <span>{timer.label || timer.name || "Timer"}</span>
              <p>{TIMER_MODES.find((item) => item.value === config.mode)?.label || "Timer"}</p>
            </div>
            <dl>
              <div><dt>Start</dt><dd>{state.start || "Not started"}</dd></div>
              <div><dt>End</dt><dd>{state.end || "Not stopped"}</dd></div>
              <div><dt>Duration</dt><dd>{state.duration ? `${state.duration}s` : "Pending"}</dd></div>
            </dl>
            {config.mode === "manual" ? (
              <div className="respondent-timer-actions">
                <button type="button" className="secondary small" disabled={Boolean(state.start)} onClick={() => startTimer(timer)}>
                  <Clock size={14} /> Start
                </button>
                <button type="button" className="secondary small" disabled={!state.start || Boolean(state.end)} onClick={() => stopTimer(timer)}>
                  <Check size={14} /> Stop
                </button>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function OdkWebFormIsland({ form, formXml, workspaceId, formApiBase, onSubmitted, onError }) {
  const mountRef = useRef(null);
  const submittedRef = useRef(onSubmitted);
  const errorRef = useRef(onError);
  const [loadState, setLoadState] = useState({ kind: "busy", message: "Loading form..." });
  const apiBase = formApiBase || `/api/forms/${encodeURIComponent(workspaceRouteId(workspaceId))}`;
  const timerController = useTimerController(form, mountRef);
  const finalizeTimersRef = useRef(timerController.finalizeTimers);

  useEffect(() => {
    submittedRef.current = onSubmitted;
    errorRef.current = onError;
  }, [onSubmitted, onError]);

  useEffect(() => {
    finalizeTimersRef.current = timerController.finalizeTimers;
  }, [timerController.finalizeTimers]);

  useEffect(() => {
    const mountPoint = mountRef.current;
    if (!mountPoint || !formXml) return undefined;
    let app = null;
    let cancelled = false;
    setLoadState({ kind: "busy", message: "Loading form..." });

    async function submitOdkPayload(payload) {
      const dataItems = Array.isArray(payload?.data) ? payload.data : [];
      let instanceXml = "";
      for (const item of dataItems) {
        const xmlSubmission = item?.get?.("xml_submission_file");
        if (xmlSubmission?.text) {
          instanceXml = await xmlSubmission.text();
          break;
        }
      }
      if (!instanceXml) throw new Error("ODK Web Forms did not provide xml_submission_file.");
      instanceXml = injectTimerValuesIntoXml(instanceXml, finalizeTimersRef.current());
      await postJson(`${apiBase}/odk-submissions`, {
        instanceXml,
        payloadType: payload?.payloadType || "monolithic",
        submissionMeta: payload?.submissionMeta || null
      });
    }

    async function mountOdkForm() {
      try {
        const {
          createApp,
          h,
          OdkWebForm,
          POST_SUBMIT__NEW_INSTANCE,
          webFormsPlugin
        } = await loadOdkWebForms();
        if (cancelled) return;
        app = createApp({
          render() {
            return h(OdkWebForm, {
              formXml,
              trackDevice: true,
              fetchFormAttachment: async (resource) => {
                const fileName = String(resource?.href || resource || "").split(/[\\/]/).filter(Boolean).pop() || "";
                return fetch(`${API_BASE}${apiBase}/attachments/${encodeURIComponent(fileName)}`, { headers: adminAuthHeaders() });
              },
              onSubmit: (payload, done) => {
                const completion = submitOdkPayload(payload)
                  .then(() => {
                    submittedRef.current?.();
                    return { next: POST_SUBMIT__NEW_INSTANCE };
                  })
                  .catch((error) => {
                    errorRef.current?.(error);
                    return null;
                  });
                done(completion);
              }
            });
          }
        });
        app.use(webFormsPlugin);
        app.mount(mountPoint);
        setLoadState({ kind: "idle", message: "" });
      } catch (error) {
        if (cancelled) return;
        const message = error?.message || String(error);
        setLoadState({ kind: "error", message });
        errorRef.current?.(error);
      }
    }

    mountOdkForm();

    return () => {
      cancelled = true;
      if (app) app.unmount();
    };
  }, [apiBase, formXml, workspaceId]);

  return (
    <>
      <TimerRespondentPanel {...timerController} />
      {loadState.kind === "busy" ? (
        <div className="status-line busy">
          <RefreshCw size={16} />
          <span>{loadState.message}</span>
        </div>
      ) : null}
      {loadState.kind === "error" ? (
        <div className="status-line error">
          <AlertCircle size={16} />
          <span>{loadState.message}</span>
        </div>
      ) : null}
      <div className="odk-web-form-host" ref={mountRef} />
    </>
  );
}

function expressionLiteral(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function priorQuestions(form, question) {
  const questions = form.questions || [];
  const index = questions.findIndex((item) => item.id === question.id);
  return questions.slice(0, Math.max(0, index)).filter((item) => item.type !== "note" && item.type !== "calculate");
}

function conditionValueOptions(question) {
  if (question?.options?.length) {
    return question.options.map((option) => ({
      value: String(option.name ?? ""),
      label: `${option.label || option.name} (${option.name})`
    }));
  }
  if (question?.type === "acknowledge") {
    return [{ value: "OK", label: "Acknowledged (OK)" }];
  }
  return [];
}

function conditionOperatorOptions(question) {
  if (["integer", "decimal", "range", "date", "dateTime"].includes(question?.type)) {
    return [
      { value: "is", label: "equals (=)" },
      { value: "is_not", label: "does not equal (!=)" },
      { value: "gt", label: "greater than (>)" },
      { value: "gte", label: "at least (>=)" },
      { value: "lt", label: "less than (<)" },
      { value: "lte", label: "at most (<=)" }
    ];
  }
  return [
    { value: "is", label: "equals (=)" },
    { value: "is_not", label: "does not equal (!=)" }
  ];
}

function conditionInputType(question) {
  if (question?.type === "integer" || question?.type === "decimal" || question?.type === "range") return "number";
  if (question?.type === "date") return "date";
  if (question?.type === "dateTime") return "datetime-local";
  if (question?.type === "time") return "time";
  return "text";
}

function conditionValueExpression(question, value) {
  if (question?.type === "integer" || question?.type === "decimal" || question?.type === "range") return String(value);
  if (question?.type === "date" || question?.type === "dateTime") return `date('${expressionLiteral(value)}')`;
  return `'${expressionLiteral(value)}'`;
}

function newConditionRow(sources, joiner = "and") {
  const source = sources[0] || null;
  const options = conditionValueOptions(source);
  return {
    id: crypto.randomUUID(),
    joiner,
    sourceName: source?.name || "",
    operator: "is",
    expectedValue: options[0]?.value || ""
  };
}

function conditionExpression(row) {
  if (!row.sourceName || row.expectedValue === "") return "";
  const source = row.source;
  if (source?.type === "select_multiple") {
    const selectedExpression = `selected(\${${row.sourceName}}, '${expressionLiteral(row.expectedValue)}')`;
    return row.operator === "is_not" ? `not(${selectedExpression})` : selectedExpression;
  }
  const operators = {
    is: "=",
    is_not: "!=",
    gt: ">",
    lt: "<",
    gte: ">=",
    lte: "<="
  };
  return `\${${row.sourceName}} ${operators[row.operator] || "="} ${conditionValueExpression(source, row.expectedValue)}`;
}

function buildRelevantExpression(mode, rows) {
  const parts = rows
    .map((row, index) => {
      const expression = conditionExpression(row);
      if (!expression) return "";
      return index === 0 ? expression : `${row.joiner} ${expression}`;
    })
    .filter(Boolean);
  if (!parts.length) return "";
  const combined = parts.join(" ");
  return mode === "skip" ? `not(${combined})` : combined;
}

function parseExpressionValue(rawValue) {
  const value = String(rawValue || "").trim();
  const dateMatch = value.match(/^date\('([^']*)'\)$/);
  if (dateMatch) return dateMatch[1];
  const quoteMatch = value.match(/^'([^']*)'$/);
  if (quoteMatch) return quoteMatch[1].replace(/\\'/g, "'");
  return value;
}

function parseRelevantExpression(expression, sources) {
  const sourceNames = new Set(sources.map((source) => source.name));
  let text = String(expression || "").trim();
  let mode = "show";
  const notMatch = text.match(/^not\((.*)\)$/);
  if (notMatch && !notMatch[1].trim().startsWith("selected(")) {
    mode = "skip";
    text = notMatch[1].trim();
  }
  const tokens = text.split(/\s+(and|or)\s+/);
  const rows = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const joiner = index === 0 ? "and" : tokens[index - 1];
    const condition = String(tokens[index] || "").trim();
    let match = condition.match(/^not\(selected\(\$\{([^}]+)\},\s*'([^']*)'\)\)$/);
    if (match && sourceNames.has(match[1])) {
      rows.push({ id: crypto.randomUUID(), joiner, sourceName: match[1], operator: "is_not", expectedValue: match[2] });
      continue;
    }
    match = condition.match(/^selected\(\$\{([^}]+)\},\s*'([^']*)'\)$/);
    if (match && sourceNames.has(match[1])) {
      rows.push({ id: crypto.randomUUID(), joiner, sourceName: match[1], operator: "is", expectedValue: match[2] });
      continue;
    }
    match = condition.match(/^\$\{([^}]+)\}\s*(>=|<=|!=|=|>|<)\s*(.+)$/);
    if (!match || !sourceNames.has(match[1])) continue;
    const operatorBySymbol = { "=": "is", "!=": "is_not", ">": "gt", "<": "lt", ">=": "gte", "<=": "lte" };
    rows.push({
      id: crypto.randomUUID(),
      joiner,
      sourceName: match[1],
      operator: operatorBySymbol[match[2]] || "is",
      expectedValue: parseExpressionValue(match[3])
    });
  }
  return { mode, rows };
}

function ConditionBuilderModal({ question, sources, onClose, onSave }) {
  const initialCondition = parseRelevantExpression(question.relevant, sources);
  const [mode, setMode] = useState(initialCondition.mode);
  const [rows, setRows] = useState(() => initialCondition.rows.length ? initialCondition.rows : sources.length ? [newConditionRow(sources)] : []);

  function rowsWithSources(currentRows) {
    return currentRows.map((row) => ({ ...row, source: sources.find((item) => item.name === row.sourceName) }));
  }

  function updateRow(rowId, patch) {
    setRows((current) => current.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
  }

  function updateSource(rowId, nextName) {
    const nextSource = sources.find((item) => item.name === nextName);
    const nextOptions = conditionValueOptions(nextSource);
    updateRow(rowId, {
      sourceName: nextName,
      operator: "is",
      expectedValue: nextOptions[0]?.value || ""
    });
  }

  function addRow(joiner = "and") {
    setRows((current) => [...current, newConditionRow(sources, joiner)]);
  }

  const expressionRows = rowsWithSources(rows);
  const generatedExpression = buildRelevantExpression(mode, expressionRows);

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="condition-modal" role="dialog" aria-modal="true" aria-label="Build display condition">
        <div className="modal-head">
          <div>
            <h2>Build Display Condition</h2>
            <p>{question.label || question.name}</p>
          </div>
          <button className="icon-button" onClick={onClose}>×</button>
        </div>

        {sources.length === 0 ? (
          <div className="empty-condition">
            <p>Add at least one earlier question before this question. Display conditions can only depend on questions that appear earlier in the form.</p>
          </div>
        ) : (
          <>
            <div className="condition-builder">
              <select value={mode} onChange={(event) => setMode(event.target.value)}>
                <option value="show">Show</option>
                <option value="skip">Skip</option>
              </select>
              <span>this question only if</span>
              {rows.map((row, index) => {
                const selectedSource = sources.find((item) => item.name === row.sourceName) || sources[0];
                const options = conditionValueOptions(selectedSource);
                const operators = conditionOperatorOptions(selectedSource);
                return (
                  <div className="condition-row" key={row.id}>
                    {index > 0 ? (
                      <select value={row.joiner} onChange={(event) => updateRow(row.id, { joiner: event.target.value })}>
                        <option value="and">and</option>
                        <option value="or">or</option>
                      </select>
                    ) : null}
                    <select value={row.sourceName} onChange={(event) => updateSource(row.id, event.target.value)}>
                      {sources.map((item) => (
                        <option key={item.id} value={item.name}>{item.label || item.name}</option>
                      ))}
                    </select>
                    <select value={row.operator} onChange={(event) => updateRow(row.id, { operator: event.target.value })}>
                      {operators.map((operator) => (
                        <option key={operator.value} value={operator.value}>{operator.label}</option>
                      ))}
                    </select>
                    {options.length ? (
                      <select value={row.expectedValue} onChange={(event) => updateRow(row.id, { expectedValue: event.target.value })}>
                        {options.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={conditionInputType(selectedSource)}
                        value={row.expectedValue}
                        placeholder="answer value"
                        onChange={(event) => updateRow(row.id, { expectedValue: event.target.value })}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            <div className="expression-preview">
              <span>Saved as ODK/XLS expression</span>
              <code>{generatedExpression || "Choose a question and value"}</code>
            </div>
          </>
        )}

        <div className="modal-actions">
          {sources.length ? (
            <button className="secondary" onClick={() => addRow("and")}>Add Condition</button>
          ) : null}
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!generatedExpression} onClick={() => onSave(generatedExpression)}>Save Conditions</button>
        </div>
      </div>
    </div>
  );
}

const LOGIC_REFERENCE_EXCLUDED_TYPES = new Set([
  "note",
  "begin_group",
  "end_group",
  "begin_repeat",
  "end_repeat",
  "csv-external",
  "audit"
]);

function isReferenceableQuestion(question) {
  return Boolean(question?.name) && !LOGIC_REFERENCE_EXCLUDED_TYPES.has(question.type);
}

function sourceDisplayLabel(source) {
  if (source?.name === ".") return "This answer";
  const label = source?.label || source?.name || "Question";
  return source?.name ? `${label} (${source.name})` : label;
}

function logicQuestionSources(form, question, { includeSelf = false, priorOnly = true } = {}) {
  const questions = form.questions || [];
  const index = questions.findIndex((item) => item.id === question.id);
  const upperBound = priorOnly ? Math.max(0, index) : questions.length;
  const slice = questions.slice(0, upperBound).filter(isReferenceableQuestion);
  const sources = slice.map((item) => ({
    id: item.id,
    name: item.name,
    label: item.label || item.name,
    type: item.type,
    options: item.options || []
  }));
  if (includeSelf) {
    sources.unshift({
      id: ".",
      name: ".",
      label: "This answer",
      type: question.type,
      options: question.options || []
    });
  }
  return sources;
}

function fieldReference(name) {
  return name === "." ? "." : `\${${name}}`;
}

function sourceForName(sources, name) {
  return sources.find((source) => source.name === name) || sources[0] || null;
}

function expressionValueForSource(source, value, valueKind = "literal") {
  if (valueKind === "answer") return fieldReference(value);
  return conditionValueExpression(source, value);
}

function logicOperatorOptions(source) {
  const type = source?.type || "text";
  if (type === "select_multiple" || type === "rank" || type === "select_multiple_from_file") {
    return [
      { value: "selected", label: "includes choice" },
      { value: "not_selected", label: "does not include choice" },
      { value: "count_eq", label: "number selected =" },
      { value: "count_gte", label: "number selected >=" },
      { value: "count_lte", label: "number selected <=" },
      { value: "is_blank", label: "is blank" },
      { value: "is_not_blank", label: "is not blank" }
    ];
  }
  if (["integer", "decimal", "range", "date", "dateTime", "time"].includes(type)) {
    return [
      { value: "is", label: "equals (=)" },
      { value: "is_not", label: "does not equal (!=)" },
      { value: "gt", label: "greater than (>)" },
      { value: "gte", label: "at least (>=)" },
      { value: "lt", label: "less than (<)" },
      { value: "lte", label: "at most (<=)" },
      { value: "is_blank", label: "is blank" },
      { value: "is_not_blank", label: "is not blank" }
    ];
  }
  return [
    { value: "is", label: "equals (=)" },
    { value: "is_not", label: "does not equal (!=)" },
    { value: "contains", label: "contains text" },
    { value: "not_contains", label: "does not contain text" },
    { value: "regex", label: "matches pattern" },
    { value: "is_blank", label: "is blank" },
    { value: "is_not_blank", label: "is not blank" }
  ];
}

function operatorNeedsValue(operator) {
  return !["is_blank", "is_not_blank"].includes(operator);
}

function operatorCanCompareQuestion(operator) {
  return ["is", "is_not", "gt", "gte", "lt", "lte"].includes(operator);
}

function defaultLogicValue(source, operator = "is") {
  if (operator === "count_eq" || operator === "count_gte" || operator === "count_lte") return "1";
  const options = conditionValueOptions(source);
  if (options.length && ["is", "is_not", "selected", "not_selected"].includes(operator)) return options[0].value;
  if (source?.type === "integer" || source?.type === "decimal" || source?.type === "range") return "0";
  if (source?.type === "date") return todayString();
  if (source?.type === "time") return "00:00";
  if (source?.type === "dateTime") return `${todayString()}T00:00`;
  return "";
}

function defaultLogicOperator(source) {
  if (!source) return "is";
  if (source.type === "select_multiple" || source.type === "rank" || source.type === "select_multiple_from_file") return "selected";
  if (conditionValueOptions(source).length) return "is";
  if (["text", "hidden", "barcode", "file", "image", "audio", "video", "select_one_from_file"].includes(source.type)) return "is_not_blank";
  return logicOperatorOptions(source)[0]?.value || "is";
}

function newLogicRule(sources, joiner = "and") {
  const source = sources[0] || null;
  const operator = defaultLogicOperator(source);
  return {
    id: crypto.randomUUID(),
    joiner,
    sourceName: source?.name || "",
    operator,
    valueKind: "literal",
    value: defaultLogicValue(source, operator)
  };
}

function logicRuleExpression(row, sources) {
  const source = sourceForName(sources, row.sourceName);
  if (!source?.name) return "";
  const ref = fieldReference(source.name);
  const literal = expressionValueForSource(source, row.value, row.valueKind);
  const stringLiteral = `'${expressionLiteral(row.value)}'`;
  if (row.operator === "selected") return `selected(${ref}, ${stringLiteral})`;
  if (row.operator === "not_selected") return `not(selected(${ref}, ${stringLiteral}))`;
  if (row.operator === "count_eq") return `count-selected(${ref}) = ${Number(row.value) || 0}`;
  if (row.operator === "count_gte") return `count-selected(${ref}) >= ${Number(row.value) || 0}`;
  if (row.operator === "count_lte") return `count-selected(${ref}) <= ${Number(row.value) || 0}`;
  if (row.operator === "is_blank") return `${ref} = ''`;
  if (row.operator === "is_not_blank") return `${ref} != ''`;
  if (row.operator === "contains") return `contains(${ref}, ${stringLiteral})`;
  if (row.operator === "not_contains") return `not(contains(${ref}, ${stringLiteral}))`;
  if (row.operator === "regex") return `regex(${ref}, ${stringLiteral})`;
  const operators = { is: "=", is_not: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
  if (!operatorNeedsValue(row.operator)) return "";
  return `${ref} ${operators[row.operator] || "="} ${literal}`;
}

function buildLogicExpression({ rows, behavior }, sources) {
  const parts = (rows || [])
    .map((row, index) => {
      const expression = logicRuleExpression(row, sources);
      if (!expression) return "";
      return index === 0 ? expression : `${row.joiner || "and"} ${expression}`;
    })
    .filter(Boolean);
  if (!parts.length) return "";
  const combined = parts.join(" ");
  return behavior === "hide" ? `not(${combined})` : combined;
}

function parseFieldReference(raw) {
  const value = String(raw || "").trim();
  if (value === ".") return ".";
  const match = value.match(/^\$\{([^}]+)\}$/);
  return match ? match[1] : "";
}

function parseLogicRule(condition, sourceNames) {
  const text = String(condition || "").trim();
  let match = text.match(/^not\(selected\((\.|\$\{[^}]+\}),\s*'([^']*)'\)\)$/);
  if (match) {
    const sourceName = parseFieldReference(match[1]);
    if (sourceNames.has(sourceName)) return { sourceName, operator: "not_selected", valueKind: "literal", value: match[2] };
  }
  match = text.match(/^selected\((\.|\$\{[^}]+\}),\s*'([^']*)'\)$/);
  if (match) {
    const sourceName = parseFieldReference(match[1]);
    if (sourceNames.has(sourceName)) return { sourceName, operator: "selected", valueKind: "literal", value: match[2] };
  }
  match = text.match(/^count-selected\((\.|\$\{[^}]+\})\)\s*(=|>=|<=)\s*(\d+)$/);
  if (match) {
    const sourceName = parseFieldReference(match[1]);
    if (sourceNames.has(sourceName)) {
      const operatorBySymbol = { "=": "count_eq", ">=": "count_gte", "<=": "count_lte" };
      return { sourceName, operator: operatorBySymbol[match[2]], valueKind: "literal", value: match[3] };
    }
  }
  match = text.match(/^not\(contains\((\.|\$\{[^}]+\}),\s*'([^']*)'\)\)$/);
  if (match) {
    const sourceName = parseFieldReference(match[1]);
    if (sourceNames.has(sourceName)) return { sourceName, operator: "not_contains", valueKind: "literal", value: match[2] };
  }
  match = text.match(/^contains\((\.|\$\{[^}]+\}),\s*'([^']*)'\)$/);
  if (match) {
    const sourceName = parseFieldReference(match[1]);
    if (sourceNames.has(sourceName)) return { sourceName, operator: "contains", valueKind: "literal", value: match[2] };
  }
  match = text.match(/^regex\((\.|\$\{[^}]+\}),\s*'([^']*)'\)$/);
  if (match) {
    const sourceName = parseFieldReference(match[1]);
    if (sourceNames.has(sourceName)) return { sourceName, operator: "regex", valueKind: "literal", value: match[2] };
  }
  match = text.match(/^(\.|\$\{[^}]+\})\s*(>=|<=|!=|=|>|<)\s*(.+)$/);
  if (!match) return null;
  const sourceName = parseFieldReference(match[1]);
  if (!sourceNames.has(sourceName)) return null;
  const operatorBySymbol = { "=": "is", "!=": "is_not", ">": "gt", "<": "lt", ">=": "gte", "<=": "lte" };
  const rhs = String(match[3] || "").trim();
  if (rhs === "''" || rhs === "\"\"") {
    return {
      sourceName,
      operator: match[2] === "!=" ? "is_not_blank" : "is_blank",
      valueKind: "literal",
      value: ""
    };
  }
  const rhsReference = parseFieldReference(rhs);
  return {
    sourceName,
    operator: operatorBySymbol[match[2]] || "is",
    valueKind: rhsReference && sourceNames.has(rhsReference) ? "answer" : "literal",
    value: rhsReference && sourceNames.has(rhsReference) ? rhsReference : parseExpressionValue(rhs)
  };
}

function parseLogicExpression(expression, sources, { allowHide = false } = {}) {
  let text = String(expression || "").trim();
  if (!text) return null;
  let behavior = "apply";
  const notMatch = text.match(/^not\((.*)\)$/);
  if (allowHide && notMatch && !notMatch[1].trim().startsWith("selected(") && !notMatch[1].trim().startsWith("contains(")) {
    behavior = "hide";
    text = notMatch[1].trim();
  }
  const sourceNames = new Set(sources.map((source) => source.name));
  const tokens = text.split(/\s+(and|or)\s+/i);
  const rows = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const parsed = parseLogicRule(tokens[index], sourceNames);
    if (!parsed) return null;
    rows.push({
      id: crypto.randomUUID(),
      joiner: index === 0 ? "and" : String(tokens[index - 1] || "and").toLowerCase(),
      ...parsed
    });
  }
  return rows.length ? { mode: "guided", behavior, rows } : null;
}

function initialLogicState(expression, sources, options = {}) {
  const parsed = parseLogicExpression(expression, sources, options);
  if (parsed) return parsed;
  return {
    mode: String(expression || "").trim() ? "raw" : "guided",
    behavior: "apply",
    rows: sources.length ? [newLogicRule(sources)] : []
  };
}

function LogicExpressionCard({
  title,
  column,
  value,
  form,
  question,
  onChange,
  readOnly = false,
  includeSelf = false,
  allowHide = false,
  toggleLabel = "Use condition",
  emptyText = "No expression saved.",
  info = ""
}) {
  const sources = useMemo(
    () => logicQuestionSources(form, question, { includeSelf, priorOnly: true }),
    [form, question, includeSelf]
  );
  const sourceKey = sources.map((source) => source.name).join("|");
  const stateKey = `${question.id}:${column}`;
  const [state, setState] = useState(() => initialLogicState(value, sources, { allowHide }));
  const [forceOpen, setForceOpen] = useState(false);

  useEffect(() => {
    setState(initialLogicState(value, sources, { allowHide }));
    setForceOpen(false);
  }, [stateKey, sourceKey]);

  const enabled = Boolean(String(value || "").trim());
  const open = enabled || forceOpen;
  const generatedExpression = state.mode === "guided" ? buildLogicExpression(state, sources) : String(value || "");
  const answerSources = sources.filter((source) => source.name !== ".");

  function commit(nextState) {
    setState(nextState);
    const expression = nextState.mode === "guided" ? buildLogicExpression(nextState, sources) : String(value || "");
    onChange(expression, {
      mode: nextState.mode,
      behavior: nextState.behavior,
      rules: nextState.rows || []
    });
  }

  function enableCondition(nextEnabled) {
    if (!nextEnabled) {
      const nextState = { ...state, mode: "guided", rows: sources.length ? state.rows?.length ? state.rows : [newLogicRule(sources)] : [] };
      setState(nextState);
      setForceOpen(false);
      onChange("", { mode: "off" });
      return;
    }
    const nextState = {
      ...state,
      mode: sources.length ? state.mode || "guided" : "raw",
      rows: state.rows?.length ? state.rows : sources.length ? [newLogicRule(sources)] : []
    };
    setForceOpen(true);
    if (sources.length) commit(nextState);
    else setState(nextState);
  }

  function setMode(mode) {
    const nextState = { ...state, mode };
    setState(nextState);
    onChange(mode === "guided" ? buildLogicExpression(nextState, sources) : String(value || ""), {
      mode,
      behavior: nextState.behavior,
      rules: nextState.rows || []
    });
  }

  function updateRow(rowId, patch) {
    const nextRows = (state.rows || []).map((row) => (row.id === rowId ? { ...row, ...patch } : row));
    commit({ ...state, rows: nextRows });
  }

  function updateRowSource(rowId, sourceName) {
    const source = sourceForName(sources, sourceName);
    const operator = defaultLogicOperator(source);
    updateRow(rowId, {
      sourceName,
      operator,
      valueKind: "literal",
      value: defaultLogicValue(source, operator)
    });
  }

  function updateRowOperator(rowId, operator) {
    const row = (state.rows || []).find((item) => item.id === rowId);
    const source = sourceForName(sources, row?.sourceName);
    updateRow(rowId, {
      operator,
      valueKind: operatorCanCompareQuestion(operator) ? row?.valueKind || "literal" : "literal",
      value: defaultLogicValue(source, operator)
    });
  }

  function addRule() {
    commit({ ...state, rows: [...(state.rows || []), newLogicRule(sources, "and")] });
  }

  function removeRule(rowId) {
    const nextRows = (state.rows || []).filter((row) => row.id !== rowId);
    commit({ ...state, rows: nextRows.length ? nextRows : sources.length ? [newLogicRule(sources)] : [] });
  }

  return (
    <div className="logic-card">
      <div className="logic-card-head">
        <div>
          <span className="logic-title-row">
            <h3>{title}</h3>
            {info ? <InfoButton label={title}>{info}</InfoButton> : null}
          </span>
          <small>ODK XLS format: "{column}" column.</small>
        </div>
        <Toggle label={toggleLabel} checked={open} disabled={readOnly} onChange={enableCondition} />
      </div>

      {!open ? (
        <p className="logic-muted">{emptyText}</p>
      ) : (
        <>
          <div className="logic-tabs">
            <button className={state.mode === "guided" ? "active" : ""} disabled={readOnly || !sources.length} onClick={() => setMode("guided")}>Builder</button>
            <button className={state.mode === "raw" ? "active" : ""} disabled={readOnly} onClick={() => setMode("raw")}>Raw</button>
          </div>

          {state.mode === "raw" ? (
            <textarea
              className="logic-raw"
              value={value || ""}
              disabled={readOnly}
              placeholder="${age} >= 18"
              onChange={(event) => onChange(event.target.value, { mode: "raw" })}
            />
          ) : sources.length ? (
            <div className="logic-builder">
              {allowHide ? (
                <label className="logic-inline-field">
                  <span>Action</span>
                  <select
                    value={state.behavior || "apply"}
                    disabled={readOnly}
                    onChange={(event) => commit({ ...state, behavior: event.target.value })}
                  >
                    <option value="apply">Show when true</option>
                    <option value="hide">Hide when true</option>
                  </select>
                </label>
              ) : null}

              {(state.rows || []).map((row, index) => {
                const source = sourceForName(sources, row.sourceName);
                const operators = logicOperatorOptions(source);
                const literalOptions = conditionValueOptions(source);
                const showValue = operatorNeedsValue(row.operator);
                const canUseAnswer = operatorCanCompareQuestion(row.operator) && answerSources.length;
                return (
                  <div className="logic-rule" key={row.id}>
                    {index > 0 ? (
                      <select value={row.joiner || "and"} disabled={readOnly} onChange={(event) => updateRow(row.id, { joiner: event.target.value })}>
                        <option value="and">and</option>
                        <option value="or">or</option>
                      </select>
                    ) : <span className="logic-rule-spacer" />}
                    <select value={row.sourceName} disabled={readOnly} onChange={(event) => updateRowSource(row.id, event.target.value)}>
                      {sources.map((item) => (
                        <option key={item.id || item.name} value={item.name}>{sourceDisplayLabel(item)}</option>
                      ))}
                    </select>
                    <select value={row.operator} disabled={readOnly} onChange={(event) => updateRowOperator(row.id, event.target.value)}>
                      {operators.map((operator) => (
                        <option key={operator.value} value={operator.value}>{operator.label}</option>
                      ))}
                    </select>
                    {showValue ? (
                      <>
                        {canUseAnswer ? (
                          <select
                            value={row.valueKind || "literal"}
                            disabled={readOnly}
                            onChange={(event) => updateRow(row.id, {
                              valueKind: event.target.value,
                              value: event.target.value === "answer" ? answerSources[0]?.name || "" : defaultLogicValue(source, row.operator)
                            })}
                          >
                            <option value="literal">value</option>
                            <option value="answer">answer</option>
                          </select>
                        ) : <span className="logic-rule-spacer" />}
                        {row.valueKind === "answer" ? (
                          <select value={row.value || ""} disabled={readOnly} onChange={(event) => updateRow(row.id, { value: event.target.value })}>
                            {answerSources.map((item) => (
                              <option key={item.id || item.name} value={item.name}>{sourceDisplayLabel(item)}</option>
                            ))}
                          </select>
                        ) : literalOptions.length && ["is", "is_not", "selected", "not_selected"].includes(row.operator) ? (
                          <select value={row.value || ""} disabled={readOnly} onChange={(event) => updateRow(row.id, { value: event.target.value })}>
                            {literalOptions.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={row.operator?.startsWith("count_") ? "number" : conditionInputType(source)}
                            value={row.value || ""}
                            disabled={readOnly}
                            placeholder={row.operator === "regex" ? "^[A-Z0-9]+$" : "value"}
                            onChange={(event) => updateRow(row.id, { value: event.target.value })}
                          />
                        )}
                      </>
                    ) : (
                      <>
                        <span className="logic-rule-spacer" />
                        <span className="logic-rule-spacer" />
                      </>
                    )}
                    <button className="icon-button danger" disabled={readOnly || (state.rows || []).length <= 1} onClick={() => removeRule(row.id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
              <button className="secondary small" disabled={readOnly || !sources.length} onClick={addRule}><Plus size={14} /> Add condition</button>
            </div>
          ) : (
            <div className="empty-state compact">Add an earlier named question, or use Raw mode for advanced references.</div>
          )}

          <div className="expression-preview">
            <span>Saved XLSForm expression</span>
            <code>{generatedExpression || "No expression generated yet"}</code>
          </div>
        </>
      )}
    </div>
  );
}

function calculationSources(form, question) {
  return logicQuestionSources(form, question, { priorOnly: true });
}

function buildCalculationExpression(config) {
  const refA = config.fieldA ? fieldReference(config.fieldA) : "";
  const refB = config.fieldB ? fieldReference(config.fieldB) : "";
  const numericValue = Number(config.numberValue || 0);
  if (config.preset === "today") return "today()";
  if (config.preset === "now") return "now()";
  if (config.preset === "empty") return "''";
  if (config.preset === "copy") return refA;
  if (config.preset === "count_selected") return refA ? `count-selected(${refA})` : "";
  if (config.preset === "sum") return refA && refB ? `${refA} + ${refB}` : "";
  if (config.preset === "difference") return refA && refB ? `${refA} - ${refB}` : "";
  if (config.preset === "multiply") return refA && refB ? `${refA} * ${refB}` : "";
  if (config.preset === "divide") return refA && refB ? `if(${refB} != 0, ${refA} div ${refB}, '')` : "";
  if (config.preset === "add_number") return refA ? `${refA} + ${numericValue}` : "";
  if (config.preset === "subtract_number") return refA ? `${refA} - ${numericValue}` : "";
  if (config.preset === "concat") return refA && refB ? `concat(${refA}, '${expressionLiteral(config.separator || " ")}', ${refB})` : "";
  if (config.preset === "age_years") return refA ? `int((decimal-date-time(today()) - decimal-date-time(${refA})) div 365.25)` : "";
  if (config.preset === "days_between") return refA && refB ? `int(decimal-date-time(${refB}) - decimal-date-time(${refA}))` : "";
  return "";
}

function initialCalculationState(value, sources) {
  const text = String(value || "").trim();
  const firstSource = sources[0]?.name || "";
  const secondSource = sources[1]?.name || firstSource;
  const base = { mode: "preset", preset: "today", fieldA: firstSource, fieldB: secondSource, separator: " ", numberValue: "0" };
  if (!text) return base;
  if (text === "today()") return { ...base, preset: "today" };
  if (text === "now()") return { ...base, preset: "now" };
  if (text === "''") return { ...base, preset: "empty" };
  const copyMatch = text.match(/^\$\{([^}]+)\}$/);
  if (copyMatch) return { ...base, preset: "copy", fieldA: copyMatch[1] };
  const countMatch = text.match(/^count-selected\(\$\{([^}]+)\}\)$/);
  if (countMatch) return { ...base, preset: "count_selected", fieldA: countMatch[1] };
  let match = text.match(/^\$\{([^}]+)\}\s*\+\s*\$\{([^}]+)\}$/);
  if (match) return { ...base, preset: "sum", fieldA: match[1], fieldB: match[2] };
  match = text.match(/^\$\{([^}]+)\}\s*-\s*\$\{([^}]+)\}$/);
  if (match) return { ...base, preset: "difference", fieldA: match[1], fieldB: match[2] };
  match = text.match(/^\$\{([^}]+)\}\s*\*\s*\$\{([^}]+)\}$/);
  if (match) return { ...base, preset: "multiply", fieldA: match[1], fieldB: match[2] };
  match = text.match(/^\$\{([^}]+)\}\s*(?:div|\/)\s*\$\{([^}]+)\}$/);
  if (match) return { ...base, preset: "divide", fieldA: match[1], fieldB: match[2] };
  match = text.match(/^int\(\(decimal-date-time\(today\(\)\)\s*-\s*decimal-date-time\(\$\{([^}]+)\}\)\)\s*div\s*365\.25\)$/);
  if (match) return { ...base, preset: "age_years", fieldA: match[1] };
  match = text.match(/^int\(decimal-date-time\(\$\{([^}]+)\}\)\s*-\s*decimal-date-time\(\$\{([^}]+)\}\)\)$/);
  if (match) return { ...base, preset: "days_between", fieldA: match[2], fieldB: match[1] };
  match = text.match(/^\$\{([^}]+)\}\s*\+\s*(-?\d+(?:\.\d+)?)$/);
  if (match) return { ...base, preset: "add_number", fieldA: match[1], numberValue: match[2] };
  match = text.match(/^\$\{([^}]+)\}\s*-\s*(-?\d+(?:\.\d+)?)$/);
  if (match) return { ...base, preset: "subtract_number", fieldA: match[1], numberValue: match[2] };
  return { ...base, mode: "raw" };
}

function calculationPresetOptions(question) {
  const type = question?.type || "text";
  const options = [{ value: "copy", label: "Copy another answer" }];
  if (type === "date") {
    options.push({ value: "today", label: "Today" });
  }
  if (type === "dateTime" || type === "time") {
    options.push({ value: "now", label: "Current date-time" });
  }
  if (["calculate", "hidden"].includes(type)) {
    options.push(
      { value: "today", label: "Today" },
      { value: "now", label: "Current date-time" }
    );
  }
  options.push({ value: "empty", label: "Clear value" });
  if (["integer", "decimal", "range", "calculate", "hidden"].includes(type)) {
    options.push(
      { value: "sum", label: "Add two answers" },
      { value: "difference", label: "Subtract two answers" },
      { value: "multiply", label: "Multiply two answers" },
      { value: "divide", label: "Divide two answers" },
      { value: "add_number", label: "Add a fixed number" },
      { value: "subtract_number", label: "Subtract a fixed number" },
      { value: "age_years", label: "Age in years from date" },
      { value: "days_between", label: "Days between two dates" },
      { value: "count_selected", label: "Count selected choices" }
    );
  }
  if (["text", "hidden", "calculate"].includes(type)) {
    options.push({ value: "concat", label: "Join two answers" });
  }
  return options;
}

function calculationNeedsFieldA(preset) {
  return !["today", "now", "empty"].includes(preset);
}

function calculationNeedsFieldB(preset) {
  return ["sum", "difference", "multiply", "divide", "concat", "days_between"].includes(preset);
}

function calculationNeedsNumber(preset) {
  return ["add_number", "subtract_number"].includes(preset);
}

function isExpressionLike(value) {
  return /\$\{|today\(\)|now\(\)|count-selected\(|decimal-date-time\(|concat\(|if\(/.test(String(value || ""));
}

function initialDefaultState(value, question, sources) {
  const text = String(value || "").trim();
  if (!text) return {
    mode: "static",
    staticValue: "",
    dynamic: initialCalculationState("", sources),
    rawValue: ""
  };
  return {
    mode: isExpressionLike(text) ? "builder" : "static",
    staticValue: isExpressionLike(text) ? "" : text,
    dynamic: initialCalculationState(text, sources),
    rawValue: text
  };
}

function defaultInputType(question) {
  if (question?.type === "integer" || question?.type === "decimal" || question?.type === "range") return "number";
  if (question?.type === "date") return "date";
  if (question?.type === "time") return "time";
  if (question?.type === "dateTime") return "datetime-local";
  return "text";
}

function defaultPlaceholder(question) {
  const type = question?.type || "";
  if (type === "geopoint" || type === "start-geopoint") return "90 0 0 0";
  if (type === "geotrace") return "90 0 0 0; 89.9 0 0 0";
  if (type === "geoshape") return "90 0 0 0; 89.9 0 0 0; 89.9 0.1 0 0; 90 0 0 0";
  if (type === "integer" || type === "decimal" || type === "range") return "0";
  if (type === "date") return todayString();
  if (type === "dateTime") return `${todayString()}T00:00`;
  if (type === "time") return "00:00";
  return "";
}

function defaultFormatHint(question) {
  const type = question?.type || "";
  if (type === "geopoint" || type === "start-geopoint") return "ODK geopoint format: latitude longitude altitude accuracy.";
  if (type === "geotrace") return "ODK trace format: multiple geopoints separated by semicolons.";
  if (type === "geoshape") return "ODK shape format: a closed set of geopoints separated by semicolons.";
  if (type === "integer" || type === "decimal" || type === "range") return "Use a numeric default only.";
  if (type === "date") return "Use a date default, or Builder > Today.";
  if (type === "dateTime") return "Use a date-time default, or Builder > Current date-time.";
  if (type === "time") return "Use a time default.";
  return "";
}

function defaultQuickValues(question) {
  const type = question?.type || "";
  if (type === "geopoint" || type === "start-geopoint") {
    return [
      { label: "North Pole", value: "90 0 0 0" },
      { label: "South Pole", value: "-90 0 0 0" }
    ];
  }
  return [];
}

function DefaultValueBuilderCard({ form, question, value, onChange, readOnly = false }) {
  const sources = useMemo(() => calculationSources(form, question), [form, question]);
  const sourceKey = sources.map((source) => source.name).join("|");
  const stateKey = `${question.id}:default`;
  const [state, setState] = useState(() => initialDefaultState(value, question, sources));
  useEffect(() => {
    setState(initialDefaultState(value, question, sources));
  }, [stateKey, sourceKey]);
  const dynamicPresetOptions = calculationPresetOptions(question).filter((item) => item.value !== "empty");
  const dynamicPreset = dynamicPresetOptions.some((item) => item.value === state.dynamic.preset)
    ? state.dynamic.preset
    : dynamicPresetOptions[0]?.value || "copy";
  const effectiveDynamic = { ...state.dynamic, preset: dynamicPreset };
  const generatedValue = state.mode === "static"
    ? state.staticValue
    : state.mode === "builder"
      ? buildCalculationExpression(effectiveDynamic)
      : state.rawValue;
  const options = conditionValueOptions(question);
  const quickValues = defaultQuickValues(question);
  const formatHint = defaultFormatHint(question);

  function commit(nextState) {
    setState(nextState);
    const nextDynamicPreset = dynamicPresetOptions.some((item) => item.value === nextState.dynamic.preset)
      ? nextState.dynamic.preset
      : dynamicPresetOptions[0]?.value || "copy";
    const nextDynamic = { ...nextState.dynamic, preset: nextDynamicPreset };
    const nextValue = nextState.mode === "static"
      ? nextState.staticValue
      : nextState.mode === "builder"
        ? buildCalculationExpression(nextDynamic)
        : nextState.rawValue;
    onChange(nextValue, {
      mode: nextState.mode,
      dynamic: nextDynamic
    });
  }

  function commitDynamic(patch) {
    commit({ ...state, mode: "builder", dynamic: { ...state.dynamic, ...patch } });
  }

  return (
    <div className="logic-card">
      <div className="logic-card-head">
        <div>
          <span className="logic-title-row">
            <h3>Default answer</h3>
            <InfoButton label="Default answer">{columnInfoText("default")}</InfoButton>
          </span>
          <small>ODK XLS format: "default" column.</small>
        </div>
      </div>
      <div className="logic-tabs">
        <button className={state.mode === "static" ? "active" : ""} disabled={readOnly} onClick={() => commit({ ...state, mode: "static" })}>Fixed</button>
        <button className={state.mode === "builder" ? "active" : ""} disabled={readOnly} onClick={() => commit({ ...state, mode: "builder" })}>Builder</button>
        <button className={state.mode === "raw" ? "active" : ""} disabled={readOnly} onClick={() => commit({ ...state, mode: "raw", rawValue: value || "" })}>Raw</button>
      </div>
      {state.mode === "static" ? (
        <label className="logic-inline-field">
          <span>Fixed answer</span>
          {options.length ? (
            <select value={state.staticValue || ""} disabled={readOnly} onChange={(event) => commit({ ...state, staticValue: event.target.value })}>
              <option value="">No default</option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : (
            <input
              type={defaultInputType(question)}
              value={state.staticValue || ""}
              disabled={readOnly}
              placeholder={defaultPlaceholder(question)}
              onChange={(event) => commit({ ...state, staticValue: event.target.value })}
            />
          )}
          {quickValues.length ? (
            <div className="default-quick-values">
              {quickValues.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className="secondary small"
                  disabled={readOnly}
                  onClick={() => commit({ ...state, staticValue: item.value })}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
          {formatHint ? <small>{formatHint}</small> : null}
        </label>
      ) : state.mode === "builder" ? (
        <div className="logic-builder compact">
          <label className="logic-inline-field">
            <span>Preset</span>
            <select value={dynamicPreset} disabled={readOnly} onChange={(event) => commitDynamic({ preset: event.target.value })}>
              {dynamicPresetOptions.map((preset) => (
                <option key={preset.value} value={preset.value}>{preset.label}</option>
              ))}
            </select>
          </label>
          {calculationNeedsFieldA(dynamicPreset) ? (
            <label className="logic-inline-field">
              <span>Answer</span>
              <select value={state.dynamic.fieldA || ""} disabled={readOnly || !sources.length} onChange={(event) => commitDynamic({ fieldA: event.target.value })}>
                {sources.length ? sources.map((source) => (
                  <option key={source.id || source.name} value={source.name}>{sourceDisplayLabel(source)}</option>
                )) : <option value="">No earlier question</option>}
              </select>
            </label>
          ) : null}
          {calculationNeedsFieldB(dynamicPreset) ? (
            <label className="logic-inline-field">
              <span>Second answer</span>
              <select value={state.dynamic.fieldB || ""} disabled={readOnly || !sources.length} onChange={(event) => commitDynamic({ fieldB: event.target.value })}>
                {sources.length ? sources.map((source) => (
                  <option key={source.id || source.name} value={source.name}>{sourceDisplayLabel(source)}</option>
                )) : <option value="">No earlier question</option>}
              </select>
            </label>
          ) : null}
          {calculationNeedsNumber(dynamicPreset) ? (
            <label className="logic-inline-field">
              <span>Fixed number</span>
              <input type="number" value={state.dynamic.numberValue || "0"} disabled={readOnly} onChange={(event) => commitDynamic({ numberValue: event.target.value })} />
            </label>
          ) : null}
          {dynamicPreset === "concat" ? (
            <label className="logic-inline-field">
              <span>Separator</span>
              <input value={state.dynamic.separator || ""} disabled={readOnly} onChange={(event) => commitDynamic({ separator: event.target.value })} />
            </label>
          ) : null}
        </div>
      ) : (
        <textarea
          className="logic-raw"
          value={state.rawValue || ""}
          disabled={readOnly}
          placeholder={defaultPlaceholder(question) || "Raw XLSForm value"}
          onChange={(event) => commit({ ...state, rawValue: event.target.value })}
        />
      )}
      <div className="expression-preview">
        <span>Saved XLSForm value</span>
        <code>{generatedValue || "No default"}</code>
      </div>
    </div>
  );
}

function CalculationBuilderCard({ form, question, value, onChange, readOnly = false }) {
  const sources = useMemo(() => calculationSources(form, question), [form, question]);
  const sourceKey = sources.map((source) => source.name).join("|");
  const stateKey = `${question.id}:calculation`;
  const [state, setState] = useState(() => initialCalculationState(value, sources));
  useEffect(() => {
    setState(initialCalculationState(value, sources));
  }, [stateKey, sourceKey]);
  const presetOptions = calculationPresetOptions(question);
  const currentPreset = presetOptions.some((item) => item.value === state.preset) ? state.preset : presetOptions[0]?.value || "copy";
  const effectiveState = { ...state, preset: currentPreset };
  const generatedExpression = state.mode === "preset" ? buildCalculationExpression(effectiveState) : String(value || "");

  function commit(nextState) {
    const nextPreset = presetOptions.some((item) => item.value === nextState.preset)
      ? nextState.preset
      : presetOptions[0]?.value || "copy";
    const normalized = { ...nextState, preset: nextPreset };
    setState(normalized);
    onChange(normalized.mode === "preset" ? buildCalculationExpression(normalized) : String(value || ""), {
      mode: normalized.mode,
      preset: normalized.preset,
      fieldA: normalized.fieldA,
      fieldB: normalized.fieldB,
      separator: normalized.separator,
      numberValue: normalized.numberValue
    });
  }
  return (
    <div className="logic-card">
      <div className="logic-card-head">
        <div>
          <span className="logic-title-row">
            <h3>Calculated value</h3>
            <InfoButton label="Calculation">{columnInfoText("calculation")}</InfoButton>
          </span>
          <small>ODK XLS format: "calculation" column.</small>
        </div>
      </div>
      <div className="logic-tabs">
        <button className={state.mode === "preset" ? "active" : ""} disabled={readOnly} onClick={() => commit({ ...state, mode: "preset" })}>Builder</button>
        <button className={state.mode === "raw" ? "active" : ""} disabled={readOnly} onClick={() => commit({ ...state, mode: "raw" })}>Raw</button>
      </div>
      {state.mode === "raw" ? (
        <textarea
          className="logic-raw"
          value={value || ""}
          disabled={readOnly}
          placeholder="today()"
          onChange={(event) => onChange(event.target.value, { mode: "raw" })}
        />
      ) : (
        <div className="logic-builder compact">
          <label className="logic-inline-field">
            <span>Preset</span>
            <select value={currentPreset} disabled={readOnly} onChange={(event) => commit({ ...state, preset: event.target.value })}>
              {presetOptions.map((preset) => (
                <option key={preset.value} value={preset.value}>{preset.label}</option>
              ))}
            </select>
          </label>
          {calculationNeedsFieldA(currentPreset) ? (
            <label className="logic-inline-field">
              <span>Answer</span>
              <select value={state.fieldA || ""} disabled={readOnly || !sources.length} onChange={(event) => commit({ ...state, fieldA: event.target.value })}>
                {sources.length ? sources.map((source) => (
                  <option key={source.id || source.name} value={source.name}>{sourceDisplayLabel(source)}</option>
                )) : <option value="">No earlier question</option>}
              </select>
            </label>
          ) : null}
          {calculationNeedsFieldB(currentPreset) ? (
            <label className="logic-inline-field">
              <span>Second answer</span>
              <select value={state.fieldB || ""} disabled={readOnly || !sources.length} onChange={(event) => commit({ ...state, fieldB: event.target.value })}>
                {sources.length ? sources.map((source) => (
                  <option key={source.id || source.name} value={source.name}>{sourceDisplayLabel(source)}</option>
                )) : <option value="">No earlier question</option>}
              </select>
            </label>
          ) : null}
          {calculationNeedsNumber(currentPreset) ? (
            <label className="logic-inline-field">
              <span>Fixed number</span>
              <input type="number" value={state.numberValue || "0"} disabled={readOnly} onChange={(event) => commit({ ...state, numberValue: event.target.value })} />
            </label>
          ) : null}
          {currentPreset === "concat" ? (
            <label className="logic-inline-field">
              <span>Separator</span>
              <input value={state.separator || ""} disabled={readOnly} onChange={(event) => commit({ ...state, separator: event.target.value })} />
            </label>
          ) : null}
        </div>
      )}
      <div className="expression-preview">
        <span>Saved XLSForm expression</span>
        <code>{generatedExpression || "No expression generated yet"}</code>
      </div>
    </div>
  );
}

function parseChoiceFilterRows(expression, sources) {
  const text = String(expression || "").trim();
  if (!text) return null;
  const sourceNames = new Set(sources.map((source) => source.name));
  const tokens = text.split(/\s+(and|or)\s+/i);
  const rows = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const part = String(tokens[index] || "").trim();
    let match = part.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)\s*(=|!=)\s*\$\{([^}]+)\}$/);
    if (match && sourceNames.has(match[3])) {
      rows.push({
        id: crypto.randomUUID(),
        joiner: index === 0 ? "and" : String(tokens[index - 1] || "and").toLowerCase(),
        choiceColumn: match[1],
        operator: match[2] === "!=" ? "!=" : "=",
        sourceName: match[3]
      });
      continue;
    }
    match = part.match(/^selected\(\$\{([^}]+)\},\s*([A-Za-z_][A-Za-z0-9_.:-]*)\)$/);
    if (match && sourceNames.has(match[1])) {
      rows.push({
        id: crypto.randomUUID(),
        joiner: index === 0 ? "and" : String(tokens[index - 1] || "and").toLowerCase(),
        choiceColumn: match[2],
        operator: "selected",
        sourceName: match[1]
      });
      continue;
    }
    return null;
  }
  return rows;
}

function buildChoiceFilterExpression(rows) {
  return (rows || [])
    .map((row, index) => {
      if (!row.choiceColumn || !row.sourceName) return "";
      const expression = row.operator === "selected"
        ? `selected(\${${row.sourceName}}, ${row.choiceColumn})`
        : `${row.choiceColumn} ${row.operator || "="} \${${row.sourceName}}`;
      return index === 0 ? expression : `${row.joiner || "and"} ${expression}`;
    })
    .filter(Boolean)
    .join(" ");
}

function ChoiceFilterBuilderCard({ form, question, value, onChange, readOnly = false }) {
  const sources = useMemo(() => logicQuestionSources(form, question, { priorOnly: true }), [form, question]);
  const sourceKey = sources.map((source) => source.name).join("|");
  const stateKey = `${question.id}:choice_filter`;
  const firstSource = sources[0]?.name || "";
  const initialRows = parseChoiceFilterRows(value, sources) || [{ id: crypto.randomUUID(), joiner: "and", choiceColumn: "filter_value", operator: "=", sourceName: firstSource }];
  const [mode, setMode] = useState(String(value || "").trim() && !parseChoiceFilterRows(value, sources) ? "raw" : "guided");
  const [rows, setRows] = useState(initialRows);
  const [forceOpen, setForceOpen] = useState(false);
  useEffect(() => {
    const parsed = parseChoiceFilterRows(value, sources);
    setMode(String(value || "").trim() && !parsed ? "raw" : "guided");
    setRows(parsed || [{ id: crypto.randomUUID(), joiner: "and", choiceColumn: "filter_value", operator: "=", sourceName: sources[0]?.name || "" }]);
    setForceOpen(false);
  }, [stateKey, sourceKey]);
  const enabled = Boolean(String(value || "").trim());
  const open = enabled || forceOpen;
  const generatedExpression = mode === "guided" ? buildChoiceFilterExpression(rows) : String(value || "");

  function commit(nextRows) {
    setRows(nextRows);
    onChange(buildChoiceFilterExpression(nextRows), { mode: "guided", rows: nextRows });
  }

  function enableFilter(nextEnabled) {
    if (!nextEnabled) {
      setForceOpen(false);
      onChange("", { mode: "off" });
      return;
    }
    setForceOpen(true);
    if (sources.length) commit(rows);
    else setMode("raw");
  }

  return (
    <div className="logic-card">
      <div className="logic-card-head">
        <div>
          <span className="logic-title-row">
            <h3>Choice Filter</h3>
            <InfoButton label="Choice Filter">{columnInfoText("choice_filter")}</InfoButton>
          </span>
          <small>ODK XLS format: "choice_filter" column.</small>
        </div>
        <Toggle label="Filter choices" checked={open} disabled={readOnly} onChange={enableFilter} />
      </div>
      {!open ? (
        <p className="logic-muted">All choices are shown.</p>
      ) : (
        <>
          <div className="logic-tabs">
            <button className={mode === "guided" ? "active" : ""} disabled={readOnly || !sources.length} onClick={() => { setMode("guided"); onChange(buildChoiceFilterExpression(rows), { mode: "guided", rows }); }}>Builder</button>
            <button className={mode === "raw" ? "active" : ""} disabled={readOnly} onClick={() => { setMode("raw"); onChange(value || "", { mode: "raw" }); }}>Raw</button>
          </div>
          {mode === "raw" ? (
            <textarea
              className="logic-raw"
              value={value || ""}
              disabled={readOnly}
              placeholder="district = ${selected_district}"
              onChange={(event) => onChange(event.target.value, { mode: "raw" })}
            />
          ) : sources.length ? (
            <div className="logic-builder">
              {rows.map((row, index) => (
                <div className="choice-filter-rule" key={row.id}>
                  {index > 0 ? (
                    <select value={row.joiner || "and"} disabled={readOnly} onChange={(event) => commit(rows.map((item) => item.id === row.id ? { ...item, joiner: event.target.value } : item))}>
                      <option value="and">and</option>
                      <option value="or">or</option>
                    </select>
                  ) : <span className="logic-rule-spacer" />}
                  <input
                    value={row.choiceColumn || ""}
                    disabled={readOnly}
                    placeholder="choices column"
                    onChange={(event) => commit(rows.map((item) => item.id === row.id ? { ...item, choiceColumn: slug(event.target.value) } : item))}
                  />
                  <select value={row.operator || "="} disabled={readOnly} onChange={(event) => commit(rows.map((item) => item.id === row.id ? { ...item, operator: event.target.value } : item))}>
                    <option value="=">equals answer</option>
                    <option value="!=">does not equal answer</option>
                    <option value="selected">is selected in answer</option>
                  </select>
                  <select value={row.sourceName || ""} disabled={readOnly} onChange={(event) => commit(rows.map((item) => item.id === row.id ? { ...item, sourceName: event.target.value } : item))}>
                    {sources.map((source) => (
                      <option key={source.id || source.name} value={source.name}>{sourceDisplayLabel(source)}</option>
                    ))}
                  </select>
                  <button className="icon-button danger" disabled={readOnly || rows.length <= 1} onClick={() => commit(rows.filter((item) => item.id !== row.id))}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button className="secondary small" disabled={readOnly} onClick={() => commit([...rows, { id: crypto.randomUUID(), joiner: "and", choiceColumn: "filter_value", operator: "=", sourceName: sources[0]?.name || "" }])}>
                <Plus size={14} /> Add filter
              </button>
            </div>
          ) : (
            <div className="empty-state compact">Choice filters need an earlier question, or use Raw mode for advanced references.</div>
          )}
          <div className="expression-preview">
            <span>Saved XLSForm expression</span>
            <code>{generatedExpression || "No expression generated yet"}</code>
          </div>
        </>
      )}
    </div>
  );
}

function RepeatCountBuilderCard({ form, question, value, onChange, readOnly = false }) {
  const sources = useMemo(() => logicQuestionSources(form, question, { priorOnly: true }), [form, question]);
  const sourceKey = sources.map((source) => source.name).join("|");
  const [mode, setMode] = useState(String(value || "").trim().match(/^\$\{[^}]+\}$/) ? "answer" : String(value || "").trim() ? "fixed" : "fixed");
  const [fixed, setFixed] = useState(String(value || "").trim().match(/^\d+$/) ? String(value).trim() : "1");
  const [sourceName, setSourceName] = useState(parseFieldReference(String(value || "").trim()) || sources[0]?.name || "");
  const stateKey = `${question.id}:repeat_count`;
  useEffect(() => {
    const text = String(value || "").trim();
    setMode(text.match(/^\$\{[^}]+\}$/) ? "answer" : text && !text.match(/^\d+$/) ? "raw" : "fixed");
    setFixed(text.match(/^\d+$/) ? text : "1");
    setSourceName(parseFieldReference(text) || sources[0]?.name || "");
  }, [stateKey, sourceKey]);

  function commit(nextMode, nextFixed = fixed, nextSourceName = sourceName, rawValue = value) {
    setMode(nextMode);
    setFixed(nextFixed);
    setSourceName(nextSourceName);
    const expression = nextMode === "fixed" ? String(Math.max(1, Number(nextFixed) || 1)) : nextMode === "answer" ? fieldReference(nextSourceName) : String(rawValue || "");
    onChange(expression, { mode: nextMode, fixed: nextFixed, sourceName: nextSourceName });
  }

  return (
    <div className="logic-card">
      <div className="logic-card-head">
        <div>
          <span className="logic-title-row">
            <h3>Repeat Count</h3>
            <InfoButton label="Repeat Count">{columnInfoText("repeat_count")}</InfoButton>
          </span>
          <small>ODK XLS format: "repeat_count" column.</small>
        </div>
      </div>
      <div className="logic-tabs">
        <button className={mode === "fixed" ? "active" : ""} disabled={readOnly} onClick={() => commit("fixed")}>Fixed</button>
        <button className={mode === "answer" ? "active" : ""} disabled={readOnly || !sources.length} onClick={() => commit("answer", fixed, sources[0]?.name || "")}>Answer</button>
        <button className={mode === "raw" ? "active" : ""} disabled={readOnly} onClick={() => commit("raw")}>Raw</button>
      </div>
      {mode === "fixed" ? (
        <label className="logic-inline-field">
          <span>Repeats</span>
          <input type="number" min="1" value={fixed} disabled={readOnly} onChange={(event) => commit("fixed", event.target.value, sourceName)} />
        </label>
      ) : mode === "answer" ? (
        <label className="logic-inline-field">
          <span>Repeat using answer</span>
          <select value={sourceName || ""} disabled={readOnly || !sources.length} onChange={(event) => commit("answer", fixed, event.target.value)}>
            {sources.length ? sources.map((source) => (
              <option key={source.id || source.name} value={source.name}>{sourceDisplayLabel(source)}</option>
            )) : <option value="">No earlier question</option>}
          </select>
        </label>
      ) : (
        <textarea
          className="logic-raw"
          value={value || ""}
          disabled={readOnly}
          placeholder="${household_members}"
          onChange={(event) => onChange(event.target.value, { mode: "raw" })}
        />
      )}
      <div className="expression-preview">
        <span>Saved XLSForm expression</span>
        <code>{mode === "fixed" ? String(Math.max(1, Number(fixed) || 1)) : mode === "answer" ? fieldReference(sourceName) : value || "No expression generated yet"}</code>
      </div>
    </div>
  );
}

function parseParameterRows(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const rows = [];
  for (const token of text.split(/\s+/)) {
    const match = token.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)=(.*)$/);
    if (!match) return null;
    rows.push({ id: crypto.randomUUID(), key: match[1], value: match[2] });
  }
  return rows;
}

function buildParameterExpression(rows) {
  return (rows || [])
    .map((row) => {
      const key = slug(row.key || "").replace(/_/g, "-");
      if (!key || row.value === "") return "";
      return `${key}=${String(row.value || "").trim()}`;
    })
    .filter(Boolean)
    .join(" ");
}

function parameterSuggestions(question) {
  if (question.type === "range") return ["start", "end", "step"];
  if (question.type === "image") return ["max-pixels", "quality"];
  if (question.type === "audio" || question.type === "video" || question.type === "background-audio") return ["max-duration"];
  if (question.type === "file") return ["accept"];
  if (question.type === "barcode") return ["formats"];
  return ["key"];
}

function ParametersBuilderCard({ question, value, onChange, readOnly = false }) {
  const stateKey = `${question.id}:parameters`;
  const parsedRows = parseParameterRows(value);
  const [mode, setMode] = useState(String(value || "").trim() && parsedRows === null ? "raw" : "guided");
  const [rows, setRows] = useState(parsedRows?.length ? parsedRows : [{ id: crypto.randomUUID(), key: parameterSuggestions(question)[0], value: "" }]);
  useEffect(() => {
    const nextRows = parseParameterRows(value);
    setMode(String(value || "").trim() && nextRows === null ? "raw" : "guided");
    setRows(nextRows?.length ? nextRows : [{ id: crypto.randomUUID(), key: parameterSuggestions(question)[0], value: "" }]);
  }, [stateKey]);
  const generatedExpression = mode === "guided" ? buildParameterExpression(rows) : String(value || "");
  const suggestions = parameterSuggestions(question);

  function commit(nextRows) {
    setRows(nextRows);
    onChange(buildParameterExpression(nextRows), { mode: "guided", rows: nextRows });
  }

  return (
    <div className="logic-card">
      <div className="logic-card-head">
        <div>
          <span className="logic-title-row">
            <h3>Parameters</h3>
            <InfoButton label="Parameters">{columnInfoText("parameters")}</InfoButton>
          </span>
          <small>ODK XLS format: "parameters" column.</small>
        </div>
      </div>
      <div className="logic-tabs">
        <button className={mode === "guided" ? "active" : ""} disabled={readOnly} onClick={() => { setMode("guided"); onChange(buildParameterExpression(rows), { mode: "guided", rows }); }}>Builder</button>
        <button className={mode === "raw" ? "active" : ""} disabled={readOnly} onClick={() => { setMode("raw"); onChange(value || "", { mode: "raw" }); }}>Raw</button>
      </div>
      {mode === "raw" ? (
        <textarea
          className="logic-raw"
          value={value || ""}
          disabled={readOnly}
          placeholder="start=0 end=100 step=1"
          onChange={(event) => onChange(event.target.value, { mode: "raw" })}
        />
      ) : (
        <div className="logic-builder">
          {rows.map((row) => (
            <div className="parameter-rule" key={row.id}>
              <input
                list={`parameter-suggestions-${question.id}`}
                value={row.key || ""}
                disabled={readOnly}
                placeholder="parameter"
                onChange={(event) => commit(rows.map((item) => item.id === row.id ? { ...item, key: event.target.value } : item))}
              />
              <input
                value={row.value || ""}
                disabled={readOnly}
                placeholder="value"
                onChange={(event) => commit(rows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))}
              />
              <button className="icon-button danger" disabled={readOnly || rows.length <= 1} onClick={() => commit(rows.filter((item) => item.id !== row.id))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <datalist id={`parameter-suggestions-${question.id}`}>
            {suggestions.map((item) => <option key={item} value={item} />)}
          </datalist>
          <button className="secondary small" disabled={readOnly} onClick={() => commit([...rows, { id: crypto.randomUUID(), key: suggestions[0], value: "" }])}>
            <Plus size={14} /> Add parameter
          </button>
        </div>
      )}
      <div className="expression-preview">
        <span>Saved XLSForm value</span>
        <code>{generatedExpression || "No parameters"}</code>
      </div>
    </div>
  );
}

function TriggerBuilderCard({ form, question, value, onChange, readOnly = false }) {
  const sources = useMemo(() => logicQuestionSources(form, question, { priorOnly: true }), [form, question]);
  const sourceKey = sources.map((source) => source.name).join("|");
  const stateKey = `${question.id}:trigger`;
  const [forceOpen, setForceOpen] = useState(false);
  const [mode, setMode] = useState(String(value || "").trim() && !parseFieldReference(value) ? "raw" : "guided");
  const [sourceName, setSourceName] = useState(parseFieldReference(value) || sources[0]?.name || "");
  useEffect(() => {
    setMode(String(value || "").trim() && !parseFieldReference(value) ? "raw" : "guided");
    setSourceName(parseFieldReference(value) || sources[0]?.name || "");
    setForceOpen(false);
  }, [stateKey, sourceKey]);
  const enabled = Boolean(String(value || "").trim());
  const open = enabled || forceOpen;
  const generatedExpression = mode === "guided" ? sourceName ? fieldReference(sourceName) : "" : String(value || "");
  const hasCalculation = Boolean(String(question.calculation || "").trim());

  function enableTrigger(nextEnabled) {
    if (!nextEnabled) {
      setForceOpen(false);
      onChange("", { mode: "off" });
      return;
    }
    setForceOpen(true);
    if (sources.length) onChange(fieldReference(sources[0].name), { mode: "guided", sourceName: sources[0].name });
    else setMode("raw");
  }

  return (
    <div className="logic-card">
      <div className="logic-card-head">
        <div>
          <span className="logic-title-row">
            <h3>Recalculate Trigger</h3>
            <InfoButton label="Recalculate trigger">{columnInfoText("trigger")}</InfoButton>
          </span>
          <small>ODK XLS format: "trigger" column.</small>
        </div>
        <Toggle label="Recalculate when another answer changes" checked={open} disabled={readOnly || !hasCalculation} onChange={enableTrigger} />
      </div>
      {!hasCalculation ? (
        <p className="logic-muted">Add a Calculated value first. A trigger only controls when that calculation reruns.</p>
      ) : !open ? (
        <p className="logic-muted">This calculated value will not be rerun by another answer changing.</p>
      ) : (
        <>
          <div className="logic-tabs">
            <button className={mode === "guided" ? "active" : ""} disabled={readOnly || !sources.length} onClick={() => { setMode("guided"); onChange(sourceName ? fieldReference(sourceName) : "", { mode: "guided", sourceName }); }}>Builder</button>
            <button className={mode === "raw" ? "active" : ""} disabled={readOnly} onClick={() => { setMode("raw"); onChange(value || "", { mode: "raw" }); }}>Raw</button>
          </div>
          {mode === "raw" ? (
            <textarea
              className="logic-raw"
              value={value || ""}
              disabled={readOnly}
              placeholder="${source_question}"
              onChange={(event) => onChange(event.target.value, { mode: "raw" })}
            />
          ) : sources.length ? (
            <label className="logic-inline-field">
              <span>Recalculate when this answer changes</span>
              <select
                value={sourceName || ""}
                disabled={readOnly}
                onChange={(event) => {
                  setSourceName(event.target.value);
                  onChange(fieldReference(event.target.value), { mode: "guided", sourceName: event.target.value });
                }}
              >
                {sources.map((source) => (
                  <option key={source.id || source.name} value={source.name}>{sourceDisplayLabel(source)}</option>
                ))}
              </select>
            </label>
          ) : (
            <div className="empty-state compact">Add an earlier named question, or use Raw mode for advanced references.</div>
          )}
          <div className="expression-preview">
            <span>Saved XLSForm value</span>
            <code>{generatedExpression || "No trigger"}</code>
          </div>
        </>
      )}
    </div>
  );
}

const APPEARANCE_PRESETS = {
  select_one: ["", "minimal", "autocomplete", "compact", "quickcompact", "label", "list-nolabel"],
  select_multiple: ["", "minimal", "compact", "quickcompact", "label", "list-nolabel"],
  rank: ["", "minimal"],
  image: ["", "annotate", "draw", "signature", "new", "selfie"],
  geopoint: ["", "maps", "placement-map", "hide-input"],
  geotrace: ["", "maps"],
  geoshape: ["", "maps"],
  range: ["", "horizontal", "vertical", "picker"],
  date: ["", "no-calendar", "month-year", "year"],
  text: ["", "numbers", "multiline", "printer", "url"]
};

function QuestionTypeField({ question, readOnly, onChange }) {
  const knownType = QUESTION_TYPES.some((item) => item.type === question.type);
  return (
    <label className="field">
      <span className="field-heading">
        <span>Question type</span>
        <InfoButton label="Question type">ODK XLS format: "type" column.</InfoButton>
      </span>
      <select
        value={question.type || "text"}
        disabled={readOnly}
        onChange={(event) => onChange(event.target.value)}
      >
        {!knownType && question.type ? (
          <option value={question.type}>Legacy imported type: {question.type}</option>
        ) : null}
        {QUESTION_TYPES.map((item) => (
          <option key={item.type} value={item.type}>{item.label}</option>
        ))}
      </select>
    </label>
  );
}

function AppearanceField({ question, readOnly, onChange }) {
  const presets = APPEARANCE_PRESETS[question.type] || [""];
  return (
    <label className="field">
      <span className="field-heading">
        <span>Appearance</span>
        <InfoButton label="Appearance">{columnInfoText("appearance")}</InfoButton>
      </span>
      <small>ODK XLS format: "appearance" column.</small>
      <div className="appearance-row">
        <select value={presets.includes(question.appearance || "") ? question.appearance || "" : "__custom"} disabled={readOnly} onChange={(event) => onChange(event.target.value === "__custom" ? question.appearance || "" : event.target.value)}>
          {presets.map((preset) => (
            <option key={preset || "blank"} value={preset}>{preset || "Default"}</option>
          ))}
          <option value="__custom">Custom</option>
        </select>
        <input value={question.appearance || ""} disabled={readOnly} placeholder="custom appearance" onChange={(event) => onChange(event.target.value)} />
      </div>
    </label>
  );
}

function MediaColumnField({ label, column, fieldName, value, accept, question, readOnly, onTextChange, onUpload }) {
  return (
    <div className="field media-column-field">
      <span className="field-heading">
        <span>{label}</span>
        <InfoButton label={label}>{columnInfoText(column)}</InfoButton>
      </span>
      <small>ODK XLS format: "{column}" column. Uploading here also adds the file as a form attachment.</small>
      <div className="media-column-row">
        <input
          value={value || ""}
          disabled={readOnly}
          placeholder="No file selected"
          onChange={(event) => onTextChange(event.target.value)}
        />
        <label className="secondary small file-action">
          <Upload size={14} /> {value ? "Replace" : "Upload"}
          <input
            type="file"
            accept={accept}
            disabled={readOnly}
            onChange={(event) => onUpload(question.id, fieldName, event)}
          />
        </label>
        {value ? (
          <button className="secondary small" disabled={readOnly} onClick={() => onTextChange("")}>
            <X size={14} /> Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

function StructuralTypeHelp({ type }) {
  const help = STRUCTURAL_TYPE_HELP[type];
  if (!help) return null;
  return (
    <div className="structural-help-card">
      <div className="structural-help-title">
        <ClipboardList size={18} />
        <span>{help.title}</span>
      </div>
      <p>{help.body}</p>
      <p>{help.xls}</p>
      <div className="structural-help-warning">
        <AlertCircle size={16} />
        <span>{help.warning}</span>
      </div>
    </div>
  );
}

function LocationTypeHelp({ question }) {
  if (!LOCATION_TYPES.has(question?.type)) return null;
  const helpByType = {
    geopoint: {
      title: "Location Point captures one GPS point",
      body: "Use this when the respondent should choose one place, such as home, hospital, household, or interview location.",
      setup: 'Use Appearance "placement-map" when the respondent should manually place or adjust the point on a map. Use blank Appearance only when you want current-location capture.'
    },
    geotrace: {
      title: "Location Trace captures a route",
      body: "Use this when the respondent should draw or record a line, such as a travel path or route.",
      setup: "Leave Appearance blank for the standard ODK browser trace widget. The saved value is a sequence of location points."
    },
    geoshape: {
      title: "Location Shape captures an area",
      body: "Use this when the respondent should draw a polygon, such as a catchment area, facility boundary, or residence zone.",
      setup: "Leave Appearance blank for the standard ODK browser shape widget. The saved value is a closed sequence of location points."
    },
    "start-geopoint": {
      title: "Start Location is auto-filled",
      body: "Use this when the form should capture the device/browser location as soon as the form opens.",
      setup: "In this local browser workflow, respondents can see the captured value. It is still filled from the device location at form start."
    }
  };
  const help = helpByType[question.type];
  return (
    <div className="location-help-card">
      <div className="location-help-title">
        <MapPin size={18} />
        <span>{help.title}</span>
      </div>
      <p>{help.body}</p>
      <p>{help.setup}</p>
      {question.type === "start-geopoint" ? (
        <div className="location-help-warning">
          <Info size={16} />
          <span>Do not use this as the Primary Identifier. It is metadata about where the form began, not a respondent answer.</span>
        </div>
      ) : null}
    </div>
  );
}

function TimerTypeHelp({ question }) {
  if (question?.type !== "timer") return null;
  return (
    <div className="timer-help-card">
      <div className="timer-help-title">
        <Clock size={18} />
        <span>Timer saves start, end, and duration</span>
      </div>
      <p>Use this when you want timing metadata without asking the respondent to type timestamps.</p>
      <p>The saved CSV/FHIR fields are generated from the timer name below.</p>
    </div>
  );
}

function TimerSettingsCard({ question, updateQuestion, readOnly = false }) {
  if (question.type !== "timer") return null;
  const config = normalizeTimerConfig(question.timerConfig);
  const fields = timerFieldNames(question);
  const mode = TIMER_MODES.find((item) => item.value === config.mode) || TIMER_MODES[0];
  const updateConfig = (patch) => {
    const next = normalizeTimerConfig({ ...config, ...patch });
    updateQuestion(question.id, { timerConfig: next });
  };
  return (
    <div className="logic-card timer-settings-card">
      <div className="logic-card-head">
        <div>
          <h3>Timer settings</h3>
          <small>Simple timing rules for the local respondent form.</small>
        </div>
      </div>
      <label className="field">
        <span className="field-heading">
          <span>When should the timer run?</span>
          <InfoButton label="Timer behavior">
            <span>Choose the event that fills the generated start and end timestamp fields.</span>
          </InfoButton>
        </span>
        <select
          value={config.mode}
          disabled={readOnly}
          onChange={(event) => updateConfig({ mode: event.target.value })}
        >
          {TIMER_MODES.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
      </label>
      <p className="logic-muted">{mode.description}</p>
      <Toggle
        label="Show timer to respondent"
        checked={config.showToRespondent}
        disabled={readOnly || config.mode === "manual"}
        onChange={(value) => updateConfig({ showToRespondent: value })}
      />
      {config.mode === "manual" ? (
        <p className="logic-muted">Manual timers are always visible because the respondent needs Start and Stop buttons.</p>
      ) : null}
      <div className="timer-field-list">
        <span>Saved fields</span>
        <code>{fields.start}</code>
        <code>{fields.end}</code>
        <code>{fields.duration}</code>
      </div>
    </div>
  );
}

function updateLogicPatch(question, column, fieldName, value, builderState = {}) {
  return {
    [fieldName]: value,
    logicBuilders: {
      ...(question.logicBuilders || {}),
      [column]: builderState
    }
  };
}

function QuestionEditor({ form, question, updateQuestion, uploadQuestionMedia, readOnly = false }) {
  const hasOptions = question.type === "select_one" || question.type === "select_multiple" || question.type === "rank";
  const hasExternalList = question.type === "select_one_from_file" || question.type === "select_multiple_from_file";
  const options = question.options || [];
  const isCalculate = question.type === "calculate";
  const isRank = question.type === "rank";
  const showRelevant = !END_STRUCTURAL_TYPES.has(question.type) && question.type !== "csv-external" && question.type !== "timer" && question.type !== "audit" || hasColumnValue(question, "relevant");
  const showRequiredControls = canRequireQuestion(question) || question.required || hasColumnValue(question, "requiredExpression", "requiredMessage");
  const showReadOnlyControls = (
    RESPONDENT_INPUT_TYPES.has(question.type) ||
    question.type === "calculate" ||
    question.type === "hidden" ||
    question.readOnly ||
    hasColumnValue(question, "readOnlyExpression")
  ) && !END_STRUCTURAL_TYPES.has(question.type) && question.type !== "csv-external" && question.type !== "audit";
  const showConstraint = canValidateAnswer(question) || hasColumnValue(question, "constraint", "constraintMessage");
  const showDefault = canDefaultQuestion(question) || hasColumnValue(question, "defaultValue");
  const showAppearance = canUseAppearance(question) || hasColumnValue(question, "appearance");
  const showParameters = canUseParameters(question) || hasColumnValue(question, "parameters");
  const showTrigger = canUseTrigger(question) || hasColumnValue(question, "trigger");
  const showCalculation = canUseCalculation(question);
  const showQuestionNote = !END_STRUCTURAL_TYPES.has(question.type) || hasColumnValue(question, "note");
  const showGuidanceHint = canUseGuidanceHint(question) || hasColumnValue(question, "guidanceHint");
  const showEntitySaveTo = RESPONDENT_INPUT_TYPES.has(question.type) || hasColumnValue(question, "saveTo");
  const showPromptMedia = canUsePromptMedia(question) || hasColumnValue(question, "image", "bigImage", "audio", "video");

  function updateOption(id, patch) {
    updateQuestion(question.id, {
      options: options.map((option) => (option.id === id ? { ...option, ...patch } : option))
    });
  }

  function addOption() {
    updateQuestion(question.id, {
      options: [...options, { id: crypto.randomUUID(), name: String(options.length + 1), label: "New option" }]
    });
  }

  function removeOption(id) {
    updateQuestion(question.id, { options: options.filter((option) => option.id !== id) });
  }

  return (
    <div className="editor-stack">
      <QuestionTypeField
        question={question}
        readOnly={readOnly}
        onChange={(nextType) => updateQuestion(question.id, questionTypePatch(question, nextType))}
      />
      <StructuralTypeHelp type={question.type} />
      <LocationTypeHelp question={question} />
      <TimerTypeHelp question={question} />
      <TimerSettingsCard question={question} updateQuestion={updateQuestion} readOnly={readOnly} />
      <Field
        label="Question name"
        value={question.name}
        disabled={readOnly}
        helpText={'ODK XLS format: "name" column.'}
        info={columnInfoText("name")}
        onChange={(value) => updateQuestion(question.id, { name: slug(value) })}
      />
      <Field
        label="Main question display text"
        value={question.label}
        disabled={readOnly}
        helpText={'ODK XLS format: "label" column.'}
        info={columnInfoText("label")}
        onChange={(value) => updateQuestion(question.id, { label: value })}
        multiline
      />
      <Field
        label="Question hint"
        value={question.hint}
        disabled={readOnly}
        helpText={'ODK XLS format: "hint" column.'}
        info={columnInfoText("hint")}
        onChange={(value) => updateQuestion(question.id, { hint: value })}
        multiline
      />
      {showRequiredControls || showReadOnlyControls ? (
        <div className="two-col">
          {showRequiredControls ? (
            <Toggle label="Required" checked={question.required} disabled={readOnly} onChange={(value) => updateQuestion(question.id, { required: value })} />
          ) : null}
          {showReadOnlyControls ? (
            <Toggle
              label="Read only"
              checked={question.readOnly || isCalculate}
              disabled={readOnly || isCalculate}
              onChange={(value) => updateQuestion(question.id, { readOnly: value })}
            />
          ) : null}
        </div>
      ) : null}
      {showRelevant ? (
        <LogicExpressionCard
          title="Question's display condition"
          column="relevant"
          value={question.relevant}
          form={form}
          question={question}
          readOnly={readOnly}
          allowHide
          toggleLabel="Use display condition"
          emptyText="This question is always shown."
          info={columnInfoText("relevant")}
          onChange={(value, builderState) => updateQuestion(question.id, updateLogicPatch(question, "relevant", "relevant", value, builderState))}
        />
      ) : null}
      {showRequiredControls ? (
        <LogicExpressionCard
          title="Conditional Required"
          column="required"
          value={question.requiredExpression}
          form={form}
          question={question}
          readOnly={readOnly || question.required}
          toggleLabel="Required only sometimes"
          emptyText={question.required ? "This question is always required." : "This question is not conditionally required."}
          info={columnInfoText("required")}
          onChange={(value, builderState) => updateQuestion(question.id, updateLogicPatch(question, "required", "requiredExpression", value, builderState))}
        />
      ) : null}
      {showReadOnlyControls ? (
        <LogicExpressionCard
          title="Conditional Read Only"
          column="read_only"
          value={question.readOnlyExpression}
          form={form}
          question={question}
          readOnly={readOnly || question.readOnly || isCalculate}
          toggleLabel="Read only sometimes"
          emptyText={question.readOnly || isCalculate ? "This question is always read only." : "This question is not conditionally read only."}
          info="Makes the answer visible but not editable only when a condition is true. Example: lock follow-up date after the first visit is completed."
          onChange={(value, builderState) => updateQuestion(question.id, updateLogicPatch(question, "read_only", "readOnlyExpression", value, builderState))}
        />
      ) : null}
      {showConstraint ? (
        <LogicExpressionCard
          title="Respondent answer condition"
          column="constraint"
          value={question.constraint}
          form={form}
          question={question}
          readOnly={readOnly}
          includeSelf
          toggleLabel="Validate answer"
          emptyText="Any answer is accepted."
          info={columnInfoText("constraint")}
          onChange={(value, builderState) => updateQuestion(question.id, updateLogicPatch(question, "constraint", "constraint", value, builderState))}
        />
      ) : null}
      {showConstraint || hasColumnValue(question, "constraintMessage") ? (
        <Field
          label="Message for respondent about the above answering condition"
          value={question.constraintMessage}
          disabled={readOnly}
          helpText={'ODK XLS format: "constraint_message" column.'}
          info={columnInfoText("constraint_message")}
          onChange={(value) => updateQuestion(question.id, { constraintMessage: value })}
        />
      ) : null}
      {showRequiredControls || hasColumnValue(question, "requiredMessage") ? (
        <Field
          label="Required message"
          value={question.requiredMessage}
          disabled={readOnly}
          helpText={'ODK XLS format: "required_message" column.'}
          info={columnInfoText("required_message")}
          onChange={(value) => updateQuestion(question.id, { requiredMessage: value })}
        />
      ) : null}
      {showDefault ? (
        <DefaultValueBuilderCard
          form={form}
          question={question}
          value={question.defaultValue}
          readOnly={readOnly}
          onChange={(value, builderState) => updateQuestion(question.id, updateLogicPatch(question, "default", "defaultValue", value, builderState))}
        />
      ) : null}
      {showCalculation ? (
        <CalculationBuilderCard
          form={form}
          question={question}
          value={question.calculation}
          readOnly={readOnly}
          onChange={(value, builderState) => updateQuestion(question.id, updateLogicPatch(question, "calculation", "calculation", value, builderState))}
        />
      ) : null}
      {showAppearance ? <AppearanceField question={question} readOnly={readOnly} onChange={(value) => updateQuestion(question.id, { appearance: value })} /> : null}
      {showParameters ? (
        <ParametersBuilderCard
          question={question}
          value={question.parameters}
          readOnly={readOnly}
          onChange={(value, builderState) => updateQuestion(question.id, updateLogicPatch(question, "parameters", "parameters", value, builderState))}
        />
      ) : null}
      {showTrigger ? (
        <TriggerBuilderCard
          form={form}
          question={question}
          value={question.trigger}
          readOnly={readOnly}
          onChange={(value, builderState) => updateQuestion(question.id, updateLogicPatch(question, "trigger", "trigger", value, builderState))}
        />
      ) : null}
      {hasOptions || hasExternalList || question.choiceFilter ? (
        <ChoiceFilterBuilderCard
          form={form}
          question={question}
          value={question.choiceFilter}
          readOnly={readOnly}
          onChange={(value, builderState) => updateQuestion(question.id, updateLogicPatch(question, "choice_filter", "choiceFilter", value, builderState))}
        />
      ) : null}
      {question.type === "begin_repeat" || question.repeatCount ? (
        <RepeatCountBuilderCard
          form={form}
          question={question}
          value={question.repeatCount}
          readOnly={readOnly}
          onChange={(value, builderState) => updateQuestion(question.id, updateLogicPatch(question, "repeat_count", "repeatCount", value, builderState))}
        />
      ) : null}
      {showQuestionNote ? <Field label="Designer note" value={question.note} disabled={readOnly} helpText={'ODK XLS format: "note" column.'} info={columnInfoText("note")} onChange={(value) => updateQuestion(question.id, { note: value })} multiline /> : null}
      {showGuidanceHint ? <Field label="Guidance hint" value={question.guidanceHint} disabled={readOnly} helpText={'ODK XLS format: "guidance_hint" column.'} info={columnInfoText("guidance_hint")} onChange={(value) => updateQuestion(question.id, { guidanceHint: value })} multiline /> : null}
      {showEntitySaveTo ? <Field label="Entity save_to" value={question.saveTo} disabled={readOnly} helpText={'ODK XLS format: "save_to" column. Leave blank unless this form creates or updates ODK Entities.'} info={columnInfoText("save_to")} onChange={(value) => updateQuestion(question.id, { saveTo: value })} /> : null}
      {showPromptMedia ? (
        <>
          <MediaColumnField
            label="Image media file"
            column="image"
            fieldName="image"
            value={question.image}
            accept="image/*"
            question={question}
            readOnly={readOnly}
            onTextChange={(value) => updateQuestion(question.id, { image: value })}
            onUpload={uploadQuestionMedia}
          />
          <MediaColumnField
            label="Big image media file"
            column="big-image"
            fieldName="bigImage"
            value={question.bigImage}
            accept="image/*"
            question={question}
            readOnly={readOnly}
            onTextChange={(value) => updateQuestion(question.id, { bigImage: value })}
            onUpload={uploadQuestionMedia}
          />
          <MediaColumnField
            label="Audio media file"
            column="audio"
            fieldName="audio"
            value={question.audio}
            accept="audio/*"
            question={question}
            readOnly={readOnly}
            onTextChange={(value) => updateQuestion(question.id, { audio: value })}
            onUpload={uploadQuestionMedia}
          />
          <MediaColumnField
            label="Video media file"
            column="video"
            fieldName="video"
            value={question.video}
            accept="video/*"
            question={question}
            readOnly={readOnly}
            onTextChange={(value) => updateQuestion(question.id, { video: value })}
            onUpload={uploadQuestionMedia}
          />
        </>
      ) : null}
      {hasOptions ? (
        <div className={`options-editor ${isRank ? "rank-items-editor" : ""}`}>
          <div className="section-head">
            <div>
              <h3>{isRank ? "Items respondents will rank" : "Options"}</h3>
              {isRank ? <p>Each row below is one item the respondent can place in order. The saved value is the item code; respondents see the display text.</p> : null}
            </div>
            <button className="secondary small" disabled={readOnly} onClick={addOption}><Plus size={14} /> {isRank ? "Add Item" : "Add"}</button>
          </div>
          <Field
            label={isRank ? "Rank item list name" : "List Name"}
            value={question.listName}
            disabled={readOnly}
            helpText={'ODK XLS format: "list_name" column in the choices sheet.'}
            info={isRank ? "All rank items are saved in one choices list. Keep this stable after publishing so older responses remain interpretable." : "The choices sheet list name that stores this question's answer options."}
            onChange={(value) => updateQuestion(question.id, { listName: slug(value).toLowerCase() })}
          />
          {options.map((option) => (
            <div className="option-block" key={option.id}>
              <div className="option-row">
                <label>
                  <span>{isRank ? "Item code" : "Value"}</span>
                  <input value={option.name} disabled={readOnly} placeholder={isRank ? "item_1" : "name"} onChange={(event) => updateOption(option.id, { name: event.target.value })} />
                </label>
                <label>
                  <span>{isRank ? "Item display text" : "Display text"}</span>
                  <input value={option.label} disabled={readOnly} placeholder={isRank ? "Item to rank" : "label"} onChange={(event) => updateOption(option.id, { label: event.target.value })} />
                </label>
                <button className="icon-button danger" disabled={readOnly} onClick={() => removeOption(option.id)}><Trash2 size={14} /></button>
              </div>
              <div className="option-media-row">
                <input value={option.image || ""} disabled={readOnly} placeholder="image" onChange={(event) => updateOption(option.id, { image: event.target.value })} />
                <input value={option.audio || ""} disabled={readOnly} placeholder="audio" onChange={(event) => updateOption(option.id, { audio: event.target.value })} />
                <input value={option.video || ""} disabled={readOnly} placeholder="video" onChange={(event) => updateOption(option.id, { video: event.target.value })} />
                <input value={option.geometry || ""} disabled={readOnly} placeholder="geometry" onChange={(event) => updateOption(option.id, { geometry: event.target.value })} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {hasExternalList ? (
        <div className="options-editor">
          <Field
            label="External choices file"
            value={question.listName}
            disabled={readOnly}
            helpText={'ODK XLS format: "type" column after select_from_file, for example choices.csv.'}
            onChange={(value) => updateQuestion(question.id, { listName: value })}
          />
        </div>
      ) : null}
    </div>
  );
}

function FillForm({ workspaceId, accessCode, onBackToRespondent }) {
  const [form, setForm] = useState(null);
  const [formXml, setFormXml] = useState("");
  const [answers, setAnswers] = useState({});
  const [submissionSuccess, setSubmissionSuccess] = useState(false);
  const [status, setStatus] = useState({ kind: "busy", message: "Loading form..." });
  const encodedWorkspaceId = workspaceId ? encodeURIComponent(workspaceRouteId(workspaceId)) : "";
  const encodedAccessCode = accessCode ? encodeURIComponent(normalizeAccessCodeInput(accessCode)) : "";
  const formApiBase = accessCode
    ? `/api/public/forms/${encodedAccessCode}`
    : `/api/forms/${encodedWorkspaceId}`;
  const calculatedAnswers = form ? computeCalculatedAnswers(form, answers) : answers;
  const questionsToShow = form ? visibleQuestions(form, calculatedAnswers) : [];

  useEffect(() => {
    async function loadPublishedForm() {
      try {
        const data = await requestJson(formApiBase);
        const draft = normalizeFormDraft(data.draft);
        let publishedForm = draft;
        if (data.hasXml) {
          const xmlData = await requestJson(`${formApiBase}/xml`);
          setFormXml(xmlData.xml || "");
          publishedForm = parseXFormXml(xmlData.xml, draft);
        } else {
          setFormXml("");
        }
        setForm(publishedForm);
        const defaults = {};
        for (const question of publishedForm.questions || []) {
          if (question.defaultValue && question.defaultValue !== "now()") defaults[question.name] = question.defaultValue;
          if (question.defaultValue === "now()" && question.type === "dateTime") {
            defaults[question.name] = new Date().toISOString().slice(0, 16);
          }
        }
        setAnswers(defaults);
        setStatus({ kind: "ok", message: data.hasXml ? "Ready in ODK Web Forms" : "Ready" });
      } catch (error) {
        setStatus({ kind: "error", message: error.message || String(error) });
      }
    }
    loadPublishedForm();
  }, [formApiBase]);

  function setAnswer(name, value) {
    setSubmissionSuccess(false);
    setAnswers((current) => ({ ...current, [name]: value }));
  }

  async function submitEntry() {
    setStatus({ kind: "busy", message: "Saving local entry..." });
    try {
      const validation = validateAnswers(form, answers);
      if (validation.errors.length) {
        setStatus({ kind: "error", message: validation.errors[0] });
        return;
      }
      const visibleNames = new Set(visibleQuestions(form, validation.answers).map((question) => question.name));
      const submissionAnswers = {};
      for (const [name, value] of Object.entries(validation.answers)) {
        if (visibleNames.has(name)) submissionAnswers[name] = value;
      }
      await postJson(`${formApiBase}/entries`, { answers: submissionAnswers });
	      setStatus({ kind: "ok", message: "Ready" });
	      setSubmissionSuccess(true);
	      setAnswers({});
    } catch (error) {
      setStatus({ kind: "error", message: error.message || String(error) });
    }
  }

  if (!form) {
    return (
      <div className="fill-shell">
        <header className="fill-header">
          <div>
            <h1>ICPH Form</h1>
            <p>{accessCode ? `Respondent code ${normalizeAccessCodeInput(accessCode)}` : "Loading workspace"}</p>
          </div>
          <div className="fill-header-actions">
            {onBackToRespondent ? (
              <button className="secondary small" onClick={onBackToRespondent}>
                <ChevronRight size={16} /> Change Code
              </button>
            ) : null}
            <div className={`status-line ${status.kind}`}><AlertCircle size={16} /> <span>{status.message}</span></div>
          </div>
        </header>
      </div>
    );
  }

  return (
    <div className="fill-shell">
      <header className="fill-header">
        <div>
          <h1>{form.title}</h1>
          <p>{accessCode ? `Respondent code ${normalizeAccessCodeInput(accessCode)}` : form.formId}</p>
        </div>
        <div className="fill-header-actions">
          {onBackToRespondent ? (
            <button className="secondary small" onClick={onBackToRespondent}>
              <ChevronRight size={16} /> Change Code
            </button>
          ) : null}
          <div className={`status-line ${status.kind}`}>
            {status.kind === "ok" ? <Check size={16} /> : <AlertCircle size={16} />}
            <span>{status.message}</span>
          </div>
        </div>
	      </header>
	      {formXml ? (
	        <main className="fill-card odk-fill-card">
	          <OdkWebFormIsland
	            form={form}
	            formXml={formXml}
	            workspaceId={workspaceId}
	            formApiBase={formApiBase}
	            onSubmitted={() => {
	              setStatus({ kind: "ok", message: "Ready in ODK Web Forms" });
	              setSubmissionSuccess(true);
	            }}
	            onError={(error) => {
	              setStatus({ kind: "error", message: error.message || String(error) });
	            }}
	          />
	          {submissionSuccess ? (
	            <div className="submission-success-inline">
	              <Check size={16} /> Submitted!
	            </div>
	          ) : null}
	        </main>
	      ) : (
	        <main className="fill-card">
	          {questionsToShow.map((question) => (
            <PreviewField
              key={question.id}
              question={question}
              value={calculatedAnswers[question.name] || ""}
              onChange={(value) => setAnswer(question.name, value)}
            />
	          ))}
	          <button className="primary submit-entry" onClick={submitEntry}>Submit Entry</button>
	          {submissionSuccess ? (
	            <div className="submission-success-inline">
	              <Check size={16} /> Submitted!
	            </div>
	          ) : null}
	        </main>
	      )}
    </div>
  );
}

function EntryViewer({ workspaceId, entryId }) {
  const [form, setForm] = useState(null);
  const [entry, setEntry] = useState(null);
  const [status, setStatus] = useState({ kind: "busy", message: "Loading entry..." });
  const answers = form && entry ? computeCalculatedAnswers(form, entry.answers || {}) : {};
  const questionsToShow = form ? visibleQuestions(form, answers) : [];

  useEffect(() => {
    async function loadEntry() {
      try {
        const [formData, entryData] = await Promise.all([
          requestJson(`/api/forms/${encodeURIComponent(workspaceId)}`),
          requestJson(`/api/forms/${encodeURIComponent(workspaceId)}/entries`)
        ]);
        const found = (entryData.entries || []).find((item) => item.id === entryId);
        if (!found) throw new Error("Entry not found.");
        const draft = normalizeFormDraft(formData.draft);
        if (formData.hasXml) {
          const xmlData = await requestJson(`/api/forms/${encodeURIComponent(workspaceId)}/xml`);
          setForm(parseXFormXml(xmlData.xml, draft));
        } else {
          setForm(draft);
        }
        setEntry(found);
        setStatus({ kind: "ok", message: formData.hasXml ? "Read-only XML entry view" : "Read-only entry view" });
      } catch (error) {
        setStatus({ kind: "error", message: error.message || String(error) });
      }
    }
    loadEntry();
  }, [workspaceId, entryId]);

  if (!form || !entry) {
    return (
      <div className="fill-shell">
        <div className={`status-line ${status.kind}`}><AlertCircle size={16} /> <span>{status.message}</span></div>
      </div>
    );
  }

  return (
    <div className="fill-shell">
      <header className="fill-header">
        <div>
          <h1>{form.title}</h1>
          <p>{entry.instanceName || entry.displayName || entry.id} · {new Date(entry.submittedAt).toLocaleString()}</p>
        </div>
        <div className={`status-line ${status.kind}`}>
          {status.kind === "ok" ? <Check size={16} /> : <AlertCircle size={16} />}
          <span>{status.message}</span>
        </div>
      </header>
      <main className="fill-card entry-view-card">
        {questionsToShow.map((question) => (
          <PreviewField
            key={question.id}
            question={question}
            value={answers[question.name] || ""}
            forceDisabled
          />
        ))}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);
