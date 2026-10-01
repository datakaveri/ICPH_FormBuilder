import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserMultiFormatOneDReader,
  BrowserMultiFormatReader,
  BrowserQRCodeReader
} from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
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
  Maximize2,
  Network,
  Plus,
  RefreshCw,
  Save,
  ScanLine,
  Search,
  Settings,
  TextCursorInput,
  Upload,
  Trash2,
  ZoomIn,
  ZoomOut,
  X
} from "lucide-react";
import "./styles.css";
import cdpgLogo from "./assets/cdpg-logo.png";
import icphLogo from "./assets/icph-logo.png";

const DEFAULT_API_BASE = typeof window === "undefined"
  ? "http://localhost:8787"
  : `${window.location.protocol}//${window.location.hostname}:8787`;
const API_BASE = import.meta.env.VITE_FORM_BUILDER_API || DEFAULT_API_BASE;
const ADMIN_TOKEN_KEY = "icph_admin_token";
const OFFLINE_DATABASE_NAME = "icph-offline-v1";
const OFFLINE_DATABASE_VERSION = 1;
let runtimeAdminToken = "";
let runtimeAdminPassword = "";
let odkWebFormsLoader = null;
let offlineDatabasePromise = null;
let submissionSyncPromise = null;

// crypto.randomUUID() is unavailable in some browsers when the app is opened
// over plain HTTP on a LAN. Keep the form builder usable outside localhost.
const crypto = {
  randomUUID() {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
};
const RESPONDENT_CODE_MODE_RANDOM = "random";
const RESPONDENT_CODE_MODE_CUSTOM = "custom";
const RESPONDENT_CODE_MAX_LENGTH = 10;

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

function BrandLogos({ variant = "topbar" }) {
  const logoClass = variant === "access" ? "access-logo" : "topbar-logo";
  return (
    <div className={`${variant === "access" ? "access-logo-pair" : "topbar-logo-pair"}`}>
      <img className={logoClass} src={icphLogo} alt="ICPH" />
      <img className={logoClass} src={cdpgLogo} alt="CDPG" />
    </div>
  );
}

function adminAuthHeaders() {
  const token = getAdminToken();
  return {
    ...(token ? { "x-admin-token": token } : {}),
    ...(runtimeAdminPassword ? { "x-admin-password": runtimeAdminPassword } : {})
  };
}

function normalizeAccessCodeInput(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, RESPONDENT_CODE_MAX_LENGTH);
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
  { type: "geopoint", label: "Point location (GPS)", icon: MapPin },
  { type: "geotrace", label: "Route / line (GPS)", icon: MapPin },
  { type: "geoshape", label: "Area / polygon (GPS)", icon: MapPin },
  { type: "start-geopoint", label: "Automatically captured start location", icon: MapPin },
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
    geopoint: { label: "Point location", appearance: "placement-map", parameters: "" },
    geotrace: { label: "Route or line", appearance: "" },
    geoshape: { label: "Area or polygon", appearance: "" },
    "start-geopoint": { label: "Start location", appearance: "" }
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
    readOnly: type === "calculate",
    demographicData: false,
    prefixWithParentIdentifier: false,
    demographicParentIdentifierVariable: "",
    demographicGeneratedId: false
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

function demographicMemberIdQuestion(name = "member_id") {
  return {
    id: crypto.randomUUID(),
    type: "text",
    name,
    label: "ID",
    hint: "Generated identifier for this demographic entry.",
    required: false,
    readOnly: true,
    calculation: "once(concat('P-', uuid(12), ''))",
    defaultValue: "",
    relevant: "",
    constraint: "",
    constraintMessage: "",
    requiredMessage: "",
    guidanceHint: "",
    note: "",
    options: [],
    extraColumns: {},
    logicBuilders: {},
    demographicGeneratedId: true,
    demographicAutoGenerated: true
  };
}

function isDemographicGeneratedIdLocked(questions = [], questionId) {
  const index = questions.findIndex((question) => question.id === questionId);
  if (index < 0) return false;
  const target = questions[index];
  if (!target.demographicGeneratedId || target.demographicAutoGenerated === false || /_copy(?:_\d+)?$/.test(String(target.name || ""))) return false;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const question = questions[cursor];
    if (question.type === "end_repeat") return false;
    if (question.type === "begin_repeat") return Boolean(question.demographicData);
  }
  return false;
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
    allowResponseEdits: false,
    limitOneResponsePerIdentifier: true,
    participantIdentifierVariable: "",
    terminologyUseLlm: false,
    multilingualEnabled: false,
    multilingualLanguage: "",
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
    terminologyUseLlm: false,
    multilingualEnabled: Boolean(form.multilingualEnabled),
    multilingualLanguage: form.multilingualLanguage || "",
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

function rangeParametersIssue(question = {}) {
  if (question.type !== "range") return "";
  const tickIntervalRaw = parameterValue(question.parameters, "tick_interval", "");
  if (!String(tickIntervalRaw).trim()) return "";
  const step = Number(parameterValue(question.parameters, "step", "1"));
  const tickInterval = Number(tickIntervalRaw);
  if (!Number.isFinite(tickInterval) || tickInterval <= 0) {
    return `${question.name || "Range question"}: tick_interval must be a positive number.`;
  }
  if (!Number.isFinite(step) || step <= 0) return "";
  const multiple = tickInterval / step;
  if (Math.abs(multiple - Math.round(multiple)) > 1e-9) {
    return `${question.name || "Range question"}: tick_interval (${tickIntervalRaw}) must be a multiple of step (${step}).`;
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

function demographicRepeatIssue(form = {}, primaryIdentifierVariable = "") {
  const primary = String(primaryIdentifierVariable || "").trim();
  if (!primary) return "";
  const questions = form.questions || [];
  const primaryIndex = questions.findIndex((question) => question.name === primary);
  for (let index = 0; index < questions.length; index += 1) {
    const repeat = questions[index];
    if (repeat.type !== "begin_repeat" || !repeat.demographicData || !repeat.prefixWithParentIdentifier) continue;
    if (primaryIndex < 0) return `The demographic repeat "${repeat.name || repeat.label || "repeat"}" needs the selected primary identifier before it in the form.`;
    if (primaryIndex > index) {
      return `Move the primary identifier question "${primary}" before demographic repeat "${repeat.name || repeat.label || "repeat"}" so generated member IDs can use it.`;
    }
  }
  return "";
}

function randomParticipantIdParts(expression) {
  const match = String(expression || "").trim().match(/^once\(concat\('((?:\\'|[^'])*)', uuid\((\d+)\), '((?:\\'|[^'])*)'\)\)$/);
  if (!match) return null;
  return {
    prefix: match[1].replace(/\\'/g, "'"),
    length: Math.max(1, Math.min(128, Number(match[2]) || 12)),
    suffix: match[3].replace(/\\'/g, "'")
  };
}

function randomParticipantIdExpression(parts, parentVariable = "") {
  const escape = (value) => expressionLiteral(value);
  const parent = String(parentVariable || "").trim();
  const prefix = escape(parts?.prefix ?? "P-");
  const suffix = escape(parts?.suffix ?? "");
  const random = `'${prefix}', uuid(${parts?.length || 12}), '${suffix}'`;
  return parent
    ? `once(concat(\${${parent}}, '-', ${random}))`
    : `once(concat(${random}))`;
}

function resolveDemographicRepeats(form = {}, primaryIdentifierVariable = "") {
  const primary = String(primaryIdentifierVariable || "").trim();
  if (!primary) return form;
  const questions = (form.questions || []).map((question) => ({ ...question }));
  for (let index = 0; index < questions.length; index += 1) {
    const repeat = questions[index];
    if (repeat.type !== "begin_repeat" || !repeat.demographicData) continue;
    const endIndex = findRepeatEnd(questions, index);
    const generated = questions.slice(index + 1, endIndex).find((question) => question.demographicGeneratedId);
    if (!generated) continue;
    generated.readOnly = true;
    generated.required = false;
    const existingCalculation = String(generated.calculation || "").trim();
    const isDefaultCalculation = !existingCalculation
      || existingCalculation === "once(uuid())"
      || existingCalculation === "once(concat('P-', uuid(12), ''))";
    if (repeat.prefixWithParentIdentifier) {
      const randomParts = randomParticipantIdParts(existingCalculation);
      if (randomParts) {
        generated.calculation = randomParticipantIdExpression(randomParts, primary);
      } else if (isDefaultCalculation) {
        generated.calculation = randomParticipantIdExpression({ prefix: "", length: 12, suffix: "" }, primary);
      }
    } else if (isDefaultCalculation) {
      generated.calculation = "once(concat('P-', uuid(12), ''))";
    }
    repeat.demographicParentIdentifierVariable = primary;
  }
  return { ...form, questions };
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
  if (form.multilingualEnabled && !secondaryLanguageName(form)) {
    issues.push("Enter the second language name before finishing Build.");
  }
  const seenNames = new Set();
  for (const [index, question] of (form.questions || []).entries()) {
    const label = question.label || `Question ${index + 1}`;
    const isEndStructural = END_STRUCTURAL_TYPES.has(question.type);
    if (question.type === "begin_repeat" && question.demographicData) {
      const endIndex = findRepeatEnd(form.questions || [], index);
      const hasGeneratedId = (form.questions || []).slice(index + 1, endIndex).some((item) => item.demographicGeneratedId);
      if (!hasGeneratedId) issues.push(`${question.name || label}: demographic repeats need a generated ID question.`);
    }
    if (!isEndStructural && !question.name?.trim()) issues.push(`${label}: name is required.`);
    if (question.name?.trim()) {
      const normalized = slug(question.name);
      if (normalized !== question.name) issues.push(`${label}: name should be XLSForm-safe, suggested: ${normalized}.`);
      if (seenNames.has(question.name)) issues.push(`${label}: duplicate question name '${question.name}'.`);
      seenNames.add(question.name);
    }
    if (!isEndStructural && !question.label?.trim()) issues.push(`${question.name}: label is required.`);
    if (form.multilingualEnabled && secondaryLanguageName(form)) {
      const respondentTextKeys = [
        ["label", "main display text"],
        ["hint", "hint"],
        ["constraintMessage", "answering condition message"],
        ["requiredMessage", "required message"],
        ["note", "designer note"],
        ["guidanceHint", "guidance hint"]
      ];
      for (const [key, labelText] of respondentTextKeys) {
        if (String(question[key] || "").trim() && !String(translatedValue(question, key) || "").trim()) {
          issues.push(`${question.name}: add ${secondaryLanguageName(form)} ${labelText}.`);
        }
      }
      if (question.type === "select_one" || question.type === "select_multiple" || question.type === "rank") {
        for (const option of question.options || []) {
          if (String(option.label || "").trim() && !String(translatedValue(option, "label") || "").trim()) {
            issues.push(`${question.name}: add ${secondaryLanguageName(form)} text for option "${option.label || option.name}".`);
          }
        }
      }
    }
    if (question.type === "calculate" && !question.calculation?.trim()) {
      issues.push(`${question.name}: calculate questions need a calculation expression.`);
    }
    if (question.trigger?.trim() && !question.calculation?.trim()) {
      issues.push(`${question.name}: trigger can only be used with a calculated value.`);
    }
    const defaultIssue = defaultValueIssue(question);
    if (defaultIssue) issues.push(defaultIssue);
    const rangeIssue = rangeParametersIssue(question);
    if (rangeIssue) issues.push(rangeIssue);
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
      if (appearanceTokens.includes("map")) {
        for (const option of options) {
          if (!String(option.geometry || "").trim()) {
            issues.push(`${question.name}: map appearance requires a map point or geometry for option "${option.label || option.name}".`);
          }
        }
      }
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
  const uuid = (length) => {
    const generated = crypto.randomUUID();
    return length ? generated.replace(/-/g, "").slice(0, Number(length)) : generated;
  };
  const once = (value) => value;
  try {
    return Function("get", "current", "selected", "decimalDateTime", "xlsDate", "today", "ifFn", "uuid", "once", `return (${js});`)(
      get,
      currentValue,
      selected,
      decimalDateTime,
      xlsDate,
      todayString,
      ifFn,
      uuid,
      once
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
      if (/^once\s*\(/i.test(question.calculation) && next[question.name]) continue;
      const value = evaluateXlsExpression(question.calculation, next);
      const normalized = value === null || value === undefined || Number.isNaN(value) ? "" : String(value);
      if (next[question.name] !== normalized) {
        next = { ...next, [question.name]: normalized };
        changed = true;
      }
    }
    for (const question of expandRepeatQuestions(form, next)) {
      if (question.demographicGeneratedId && question.answerKey && !next[question.answerKey]) {
        const parentVariable = question.demographicParentIdentifierVariable || form.primaryIdentifierVariable || "";
        const parentValue = parentVariable ? String(next[parentVariable] || "").trim() : "";
        const memberNumber = String(question.repeatIndex || 1).padStart(3, "0");
        const generated = question.prefixWithParentIdentifier && parentValue
          ? `${parentValue}-M${memberNumber}`
          : `${question.demographicRepeatName || "member"}-M${memberNumber}`;
        next = { ...next, [question.answerKey]: generated };
        changed = true;
        continue;
      }
      if (!question.calculation?.trim() || !question.answerKey) continue;
      if (/^once\s*\(/i.test(question.calculation) && next[question.answerKey]) continue;
      const scopedAnswers = { ...next, [question.name]: next[question.answerKey] || "" };
      const value = evaluateXlsExpression(question.calculation, scopedAnswers);
      const normalized = value === null || value === undefined || Number.isNaN(value) ? "" : String(value);
      if (next[question.answerKey] !== normalized) {
        next = { ...next, [question.answerKey]: normalized };
        changed = true;
      }
    }
    if (!changed) break;
  }
  return next;
}

function indexedAnswerKey(name, repeatPath = []) {
  return `${name}${repeatPath.map((index) => `__repeat_${index}`).join("")}`;
}

function repeatCountValue(question, answers, repeatPath = []) {
  const expression = String(question.repeatCount || question.repeat_count || "").trim();
  if (!expression) return 1;
  const reference = parseFieldReference(expression);
  const referenceKey = reference ? indexedAnswerKey(reference, repeatPath) : "";
  const scopedAnswers = reference ? { ...answers, [reference]: answers[referenceKey] ?? "" } : answers;
  const rawValue = reference ? scopedAnswers[reference] : /^\d+$/.test(expression) ? expression : evaluateXlsExpression(expression, scopedAnswers);
  const count = Number(rawValue);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 1;
}

function findRepeatEnd(questions, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < questions.length; index += 1) {
    const type = questions[index]?.type;
    if (type === "begin_repeat") depth += 1;
    if (type === "end_repeat") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return questions.length;
}

function expandRepeatQuestions(form, answers = {}) {
  const questions = form?.questions || [];
  const expanded = [];
  function appendRange(start, end, repeatPath = [], repeatMeta = []) {
    for (let index = start; index < end; index += 1) {
      const question = questions[index];
      if (question.type === "end_group" || question.type === "end_repeat") continue;
      if (question.type === "begin_repeat") {
        const endIndex = findRepeatEnd(questions, index);
        const count = repeatCountValue(question, answers, repeatPath);
        for (let repeatIndex = 1; repeatIndex <= count; repeatIndex += 1) {
          appendRange(index + 1, endIndex, [...repeatPath, repeatIndex], [
            ...repeatMeta,
            {
              index: repeatIndex,
              count,
              label: question.label || question.name || "Repeat",
              demographicData: Boolean(question.demographicData),
              prefixWithParentIdentifier: Boolean(question.prefixWithParentIdentifier),
              demographicParentIdentifierVariable: question.demographicParentIdentifierVariable || "",
              demographicRepeatName: question.name || "member"
            }
          ]);
        }
        index = endIndex;
        continue;
      }
      const answerKey = question.name && repeatPath.length ? indexedAnswerKey(question.name, repeatPath) : question.name || "";
      const lastRepeat = repeatMeta[repeatMeta.length - 1];
      expanded.push({
        ...question,
        id: repeatPath.length ? `${question.id || question.name}::repeat:${repeatPath.join(".")}` : question.id,
        answerKey,
        repeatIndex: lastRepeat?.index || 0,
        repeatPath,
        repeatCount: lastRepeat?.count || 0,
        repeatLabel: lastRepeat?.label || "Repeat",
        demographicData: Boolean(lastRepeat?.demographicData),
        prefixWithParentIdentifier: Boolean(lastRepeat?.prefixWithParentIdentifier),
        demographicParentIdentifierVariable: lastRepeat?.demographicParentIdentifierVariable || "",
        demographicRepeatName: lastRepeat?.demographicRepeatName || "member"
      });
    }
  }
  appendRange(0, questions.length);
  return expanded;
}

function questionAnswerKey(question) {
  return question?.answerKey || question?.name || "";
}

function questionScopedAnswers(question, answers) {
  if (!question?.answerKey || !question.name) return answers;
  return { ...answers, [question.name]: answers[question.answerKey] || "" };
}

function normalizeStoredRepeatAnswers(form, answers = {}) {
  const next = { ...answers };
  for (const question of expandRepeatQuestions(form, next)) {
    if (!question.answerKey || !Array.isArray(next[question.name]) || next[question.answerKey] !== undefined) continue;
    next[question.answerKey] = next[question.name][Math.max(0, (question.repeatIndex || 1) - 1)] ?? "";
  }
  return next;
}

function visibleQuestions(form, answers) {
  const calculated = computeCalculatedAnswers(form, answers);
  return expandRepeatQuestions(form, calculated).filter((question) => (
    question.type !== "end_group" &&
    question.type !== "end_repeat" &&
    !NON_DISPLAY_TYPES.has(question.type) &&
    isQuestionVisible(question, questionScopedAnswers(question, calculated))
  ));
}

function groupedQuestionPages(questions = []) {
  const pages = [];
  let currentPage = [];
  for (const question of questions) {
    if (question.type === "begin_group" && currentPage.length) {
      pages.push(currentPage);
      currentPage = [];
    }
    currentPage.push(question);
  }
  if (currentPage.length) pages.push(currentPage);
  return pages;
}

function validateAnswers(form, answers, questionSubset = null) {
  const calculated = computeCalculatedAnswers(form, answers);
  const errors = [];
  for (const question of questionSubset || visibleQuestions(form, calculated)) {
    if (question.type === "note" || question.type === "calculate") continue;
    const scopedAnswers = questionScopedAnswers(question, calculated);
    const answerKey = questionAnswerKey(question);
    const value = calculated[answerKey] ?? "";
    const requiredByExpression = question.requiredExpression?.trim()
      ? Boolean(evaluateXlsExpression(question.requiredExpression, scopedAnswers, value))
      : false;
    if ((question.required || requiredByExpression) && String(value).trim() === "") {
      errors.push(`${question.label || question.name}${question.repeatIndex ? ` (repeat ${question.repeatIndex})` : ""} is required.`);
    }
    if (String(value).trim() && question.constraint?.trim()) {
      const ok = Boolean(evaluateXlsExpression(question.constraint, scopedAnswers, value));
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

function openOfflineDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("Offline storage is unavailable in this browser."));
  if (!offlineDatabasePromise) {
    offlineDatabasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(OFFLINE_DATABASE_NAME, OFFLINE_DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("formPackages")) database.createObjectStore("formPackages", { keyPath: "accessCode" });
        if (!database.objectStoreNames.contains("offlineDrafts")) database.createObjectStore("offlineDrafts", { keyPath: "id" });
        if (!database.objectStoreNames.contains("submissionQueue")) database.createObjectStore("submissionQueue", { keyPath: "id" });
        if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta", { keyPath: "key" });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          offlineDatabasePromise = null;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        offlineDatabasePromise = null;
        reject(request.error || new Error("Could not open offline storage."));
      };
    });
  }
  return offlineDatabasePromise;
}

function offlineStoreRequest(storeName, mode, action) {
  return openOfflineDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Offline storage transaction was aborted."));
  }));
}

async function offlineCryptoKey() {
  const stored = await offlineStoreRequest("meta", "readonly", (store) => store.get("deviceKey"));
  if (stored?.value) return stored.value;
  if (!globalThis.crypto?.subtle) throw new Error("Secure offline storage requires a supported HTTPS browser.");
  const value = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  try {
    await offlineStoreRequest("meta", "readwrite", (store) => store.add({ key: "deviceKey", value }));
    return value;
  } catch {
    const winner = await offlineStoreRequest("meta", "readonly", (store) => store.get("deviceKey"));
    if (winner?.value) return winner.value;
    throw new Error("Could not initialize encrypted offline storage.");
  }
}

async function saveEncryptedOfflineRecord(storeName, record) {
  const key = await offlineCryptoKey();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  const ciphertext = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  await offlineStoreRequest(storeName, "readwrite", (store) => store.put({
    id: record.id,
    createdAt: record.createdAt || Date.now(),
    iv,
    ciphertext
  }));
}

async function readEncryptedOfflineRecord(storeName, item) {
  const key = await offlineCryptoKey();
  const plaintext = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: item.iv }, key, item.ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function readEncryptedOfflineRecords(storeName) {
  const stored = await offlineStoreRequest(storeName, "readonly", (store) => store.getAll());
  const records = await Promise.all(stored.map(async (item) => {
    try { return await readEncryptedOfflineRecord(storeName, item); } catch { return null; }
  }));
  return records.filter(Boolean).sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
}

async function loadOfflineFormPackage(accessCode) {
  return offlineStoreRequest("formPackages", "readonly", (store) => store.get(normalizeAccessCodeInput(accessCode)));
}

async function listOfflineFormPackages() {
  const packages = await offlineStoreRequest("formPackages", "readonly", (store) => store.getAll());
  return packages.map((item) => {
    const form = item.form || item.draft || {};
    const identifier = form.participantIdentifierVariable || form.primaryIdentifierVariable || "";
    return {
      accessCode: item.accessCode,
      title: item.title || form.title,
      formId: item.formId || form.formId,
      cachedAt: item.cachedAt,
      primaryIdentifierVariable: identifier,
      participantIdentifierVariable: identifier,
      displayFields: entryCsvQuestions(form).map((question) => {
        const name = question.name;
        return { name, label: question?.label || name };
      }),
      entries: [],
      offlineAvailable: true
    };
  });
}

async function saveOfflineFormPackage(formPackage) {
  await offlineStoreRequest("formPackages", "readwrite", (store) => store.put(formPackage));
  try { await navigator.storage?.persist?.(); } catch {}
}

function offlineDraftId(accessCode, workspaceId = "", entryId = "") {
  return `${normalizeAccessCodeInput(accessCode) || workspaceRouteId(workspaceId)}:${entryId || "active"}`;
}

async function saveOfflineFirst(path, payload) {
  const id = crypto.randomUUID();
  try {
    await offlineStoreRequest("meta", "readwrite", (store) => store.put({ key: "apiBase", value: API_BASE }));
    await saveEncryptedOfflineRecord("submissionQueue", {
      id,
      path,
      payload,
      createdAt: Date.now()
    });
  } catch (error) {
    if (!navigator.onLine) throw error;
    await postJson(path, { ...payload, clientSubmissionId: id });
    return { id, queued: false, error: "", pendingCount: await getPendingSubmissionCount() };
  }
  try {
    const registration = await navigator.serviceWorker?.ready;
    await registration?.sync?.register?.("icph-submit-queue");
  } catch {}
  const result = await syncPendingSubmissions(id);
  return { id, queued: !result.syncedIds.includes(id), error: result.errors[id] || "", pendingCount: result.pendingCount };
}

async function syncPendingSubmissions(onlyId = "") {
  if (!navigator.onLine) return { syncedIds: [], errors: {}, pendingCount: await getPendingSubmissionCount() };
  if (submissionSyncPromise) {
    const ongoingResult = await submissionSyncPromise;
    if (!onlyId || ongoingResult.syncedIds.includes(onlyId) || !navigator.onLine) return ongoingResult;
    return syncPendingSubmissions(onlyId);
  }
  submissionSyncPromise = (async () => {
    const records = await readEncryptedOfflineRecords("submissionQueue");
    const syncedIds = [];
    const errors = {};
    for (const record of records) {
      if (onlyId && record.id !== onlyId) continue;
      try {
        await postJson(record.path, { ...record.payload, clientSubmissionId: record.id });
        await offlineStoreRequest("submissionQueue", "readwrite", (store) => store.delete(record.id));
        syncedIds.push(record.id);
      } catch (error) {
        errors[record.id] = error.message || String(error);
        if (!error.status || error.status >= 500) break;
      }
    }
    return { syncedIds, errors, pendingCount: await getPendingSubmissionCount() };
  })().finally(() => { submissionSyncPromise = null; });
  return submissionSyncPromise;
}

async function getPendingSubmissionCount() {
  try { return (await offlineStoreRequest("submissionQueue", "readonly", (store) => store.count())) || 0; }
  catch { return 0; }
}

function notifyCollectionChanged() {
  try {
    window.localStorage.setItem("icph_collection_changed_at", String(Date.now()));
  } catch {}
  try {
    window.opener?.postMessage({ type: "icph:collection-changed" }, window.location.origin);
  } catch {}
}

function deleteJson(path, payload = undefined) {
  return requestJson(path, {
    method: "DELETE",
    ...(payload === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function attachmentUrl(workspaceId, href, accessCode = "") {
  const fileName = String(href || "").split(/[\\/]/).filter(Boolean).pop() || "";
  const base = accessCode
    ? `/api/public/forms/${encodeURIComponent(normalizeAccessCodeInput(accessCode))}`
    : `/api/forms/${encodeURIComponent(workspaceRouteId(workspaceId))}`;
  return `${API_BASE}${base}/attachments/${encodeURIComponent(fileName)}`;
}

function mediaSource(value, workspaceId = "", accessCode = "", cachedAttachments = {}) {
  const source = String(value || "").trim();
  if (!source) return "";
  if (/^(data:|blob:|https?:\/\/)/i.test(source)) return source;
  if (accessCode && cachedAttachments[resourceFileKey(source)]) return cachedAttachments[resourceFileKey(source)];
  return attachmentUrl(workspaceId, source, accessCode);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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
  const questionNames = new Set(questions.map((question) => String(question?.name || "").trim()).filter(Boolean));
  const sourcePrimaryIdentifier = String(source.primaryIdentifierVariable || "").trim();
  const sourceParticipantIdentifier = String(source.participantIdentifierVariable || "").trim();
  const effectivePrimaryIdentifier = questionNames.has(sourcePrimaryIdentifier)
    ? sourcePrimaryIdentifier
    : questionNames.has(sourceParticipantIdentifier)
      ? sourceParticipantIdentifier
      : sourcePrimaryIdentifier;
  return {
    ...base,
    ...source,
    terminologyUseLlm: false,
    primaryIdentifierVariable: effectivePrimaryIdentifier,
    questions: questions.map((question, index) => {
      const isEndStructural = END_STRUCTURAL_TYPES.has(question.type);
      return ({
      id: question.id || `question_${index + 1}_${slug(question.name || question.label || "field")}`,
      type: question.type || "text",
      name: isEndStructural ? "" : question.name || `q${index + 1}`,
      label: isEndStructural ? "" : question.label || question.name || `Question ${index + 1}`,
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
      translations: question.translations && typeof question.translations === "object" ? question.translations : {},
      extraColumns: question.extraColumns && typeof question.extraColumns === "object" ? question.extraColumns : {},
      logicBuilders: question.logicBuilders && typeof question.logicBuilders === "object" ? question.logicBuilders : {},
      timerConfig: normalizeTimerConfig(question.timerConfig),
      readOnly: booleanColumnTrue(question.readOnly),
      demographicData: Boolean(question.demographicData),
      prefixWithParentIdentifier: Boolean(question.prefixWithParentIdentifier),
      demographicParentIdentifierVariable: question.demographicParentIdentifierVariable || "",
      demographicGeneratedId: Boolean(question.demographicGeneratedId),
      demographicAutoGenerated: question.demographicAutoGenerated !== false && !/_copy(?:_\d+)?$/.test(String(question.name || "")),
      identifierLocked: Boolean(question.identifierLocked),
      folderSharedIdentifier: question.folderSharedIdentifier || "",
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
            translations: option.translations && typeof option.translations === "object" ? option.translations : {},
            extraColumns: option.extraColumns && typeof option.extraColumns === "object" ? option.extraColumns : {}
          }))
        : []
      });
    })
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
  const fallbackQuestionByName = new Map((fallbackDraft.questions || []).map((question) => [question.name, question]));
  const xmlQuestions = controls.map((control, index) => {
    const name = leafNameFromPath(control.getAttribute("ref") || control.getAttribute("nodeset")) || `q${index + 1}`;
    const fallbackQuestion = fallbackQuestionByName.get(name) || {};
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
    const options = type === "select_one" || type === "select_multiple" ? parseXFormChoices(control, choiceInstances).map((option) => {
      const fallbackOption = (fallbackQuestion.options || []).find((item) => String(item.name || "") === String(option.name || ""));
      return fallbackOption ? { ...option, translations: fallbackOption.translations || {} } : option;
    }) : [];
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
      options,
      translations: fallbackQuestion.translations || {},
      requiredMessage: fallbackQuestion.requiredMessage || "",
      guidanceHint: fallbackQuestion.guidanceHint || "",
      note: fallbackQuestion.note || ""
    };
  });

  const xmlQuestionByName = new Map(xmlQuestions.map((question) => [question.name, question]));
  const fallbackQuestions = Array.isArray(fallbackDraft.questions) ? fallbackDraft.questions : [];
  const questions = fallbackQuestions.length
    ? fallbackQuestions.map((fallbackQuestion) => {
        if (STRUCTURAL_TYPES.has(fallbackQuestion.type)) return fallbackQuestion;
        return {
          ...fallbackQuestion,
          ...(xmlQuestionByName.get(fallbackQuestion.name) || {}),
          // The XForm control is intentionally generic for several ODK types
          // (uploads, barcode, preload fields). Keep the authored XLSForm type
          // so the browser viewer can render the right control.
          type: fallbackQuestion.type || xmlQuestionByName.get(fallbackQuestion.name)?.type || "text"
        };
      })
    : xmlQuestions;
  const fallbackNames = new Set(questions.map((question) => question.name).filter(Boolean));
  const additionalXmlQuestions = xmlQuestions.filter((question) => !fallbackNames.has(question.name));

  return normalizeFormDraft({
    ...fallbackDraft,
    title,
    formId,
    version,
    questions: [...questions, ...additionalXmlQuestions],
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

function secondaryLanguageName(form = {}) {
  return form.multilingualEnabled ? String(form.multilingualLanguage || "").trim() : "";
}

function translatedValue(source = {}, key, language = "secondary") {
  return source?.translations?.[language]?.[key] || "";
}

function withTranslatedValue(source = {}, key, value, language = "secondary") {
  return {
    ...source,
    translations: {
      ...(source.translations || {}),
      [language]: {
        ...(source.translations?.[language] || {}),
        [key]: value
      }
    }
  };
}

function localizedQuestion(question = {}, key, languageMode = "default") {
  return languageMode === "secondary"
    ? translatedValue(question, key) || question[key] || ""
    : question[key] || "";
}

function localizedOption(option = {}, key, languageMode = "default") {
  return languageMode === "secondary"
    ? translatedValue(option, key) || option[key] || ""
    : option[key] || "";
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
  return dataExportQuestions(form).filter((question) => {
      const name = String(question?.name || "").trim();
      if (!name || seen.has(name)) return false;
      if (STRUCTURAL_TYPES.has(question.type)) return false;
      if (["note", "csv-external", "timer", "audit", "background-audio"].includes(question.type)) return false;
      seen.add(name);
      return true;
    });
}

function entryDisplayOptions(form = {}) {
  return entryCsvQuestions(form).map((question) => ({
    name: question.name,
    label: displayFormText(question.label || question.name) || question.name
  }));
}

function entryExportValue(answers = {}, question = {}) {
  const name = String(question.name || "").trim();
  const prefix = `${name}__repeat_`;
  const repeatValues = Object.keys(answers)
    .filter((key) => key.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((key) => answers[key]);
  if (repeatValues.length) return repeatValues;
  if (Object.prototype.hasOwnProperty.call(answers, name)) return answers[name];
  return "";
}

function entryDisplayValue(entry, displayField = "") {
  const field = String(displayField || "").trim();
  if (field) {
    const value = csvValue(entryExportValue(entry?.answers || {}, { name: field }));
    if (String(value ?? "").trim()) return String(value);
  }
  return entry?.instanceName || entry?.displayName || entry?.id || "Entry";
}

function entriesToCsv(form, entries) {
  const questions = entryCsvQuestions(form);
  const headers = questions.map((question) => String(question.name || "").trim());
  const rows = [headers.map(csvEscape).join(",")];
  for (const entry of entries) {
    const answers = computeCalculatedAnswers(form, entry.answers || {});
    rows.push(questions.map((question) => csvEscape(entryExportValue(answers, question))).join(","));
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

function Field({ label, value, onChange, placeholder, helpText, info, multiline = false, autoGrow = false, type = "text", disabled = false, secondaryLabel = "", secondaryValue = "", onSecondaryChange }) {
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
      {secondaryLabel && onSecondaryChange ? (
        <span className="secondary-language-input">
          <small>{secondaryLabel}</small>
          {multiline ? (
            <textarea
              value={secondaryValue || ""}
              placeholder={`${secondaryLabel} ${label}`}
              disabled={disabled}
              onChange={(event) => onSecondaryChange(event.target.value)}
            />
          ) : (
            <input
              type={type}
              value={secondaryValue || ""}
              placeholder={`${secondaryLabel} ${label}`}
              disabled={disabled}
              onChange={(event) => onSecondaryChange(event.target.value)}
            />
          )}
        </span>
      ) : null}
    </label>
  );
}

function Toggle({ label, checked, onChange, disabled = false, hideLabel = false }) {
  return (
    <label className={`toggle ${hideLabel ? "toggle-icon-only" : ""} ${checked ? "checked" : ""}`}>
      <input
        type="checkbox"
        checked={Boolean(checked)}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-control" aria-hidden="true" />
      <span className={hideLabel ? "sr-only" : ""}>{label}</span>
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
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/service-worker.js")
      .then((registration) => {
        const configure = (worker) => worker?.postMessage({ type: "icph:configure", apiBase: API_BASE });
        configure(registration.active || registration.waiting || registration.installing);
        navigator.serviceWorker.ready.then((readyRegistration) => configure(readyRegistration.active));
      })
      .catch((error) => console.warn("ICPH offline app setup failed:", error));
  }, []);
  if (path.startsWith("/folder-visualization/")) {
    return <FolderVisualizationPage folderId={decodeURIComponent(path.replace("/folder-visualization/", "").split("/")[0] || "")} />;
  }
  if (path.startsWith("/respondent")) {
    const initialCode = decodeURIComponent(path.replace(/^\/respondent\/?/, "").split("/")[0] || "");
    return <RespondentPortal initialCode={initialCode} />;
  }
  if (path === "/field-agent") {
    return <FieldAgentPortal />;
  }
  if (path.startsWith("/public-fill/")) {
    const params = new URLSearchParams(window.location.search);
    return <FillForm accessCode={decodeURIComponent(path.replace("/public-fill/", "").split("/")[0])} entryId={params.get("entryId") || ""} />;
  }
  if (path.startsWith("/fill/")) {
    const params = new URLSearchParams(window.location.search);
    return <FillForm workspaceId={decodeURIComponent(path.replace("/fill/", "").split("/")[0])} entryId={params.get("entryId") || ""} />;
  }
  if (path.startsWith("/entry/")) {
    const parts = path.replace("/entry/", "").split("/");
    return <EntryViewer workspaceId={decodeURIComponent(parts[0] || "")} entryId={decodeURIComponent(parts[1] || "")} />;
  }
  return <AdminApp />;
}

function visibleVersionForFolderForms(forms = [], folderId = "") {
  const groups = new Map();
  for (const form of forms.filter((item) => item.folderId === folderId && item.hasXml && item.respondentAccessCode && !item.collectionLocked)) {
    const key = form.versionBaseId
      || form.formId
      || form.title
      || String(form.workspaceId || "").replace(/_v\d+$/i, "");
    const group = groups.get(key) || [];
    group.push(form);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((versions) => {
      const ordered = versions.slice().sort((a, b) => Number(a.versionNumber || 1) - Number(b.versionNumber || 1));
      return ordered.filter((item) => !item.collectionLocked).at(-1) || ordered.at(-1);
    })
    .filter(Boolean);
}

function folderVisualizationResponseValue(entry, form, displayVariable = "") {
  const identifier = displayVariable || form.participantIdentifierVariable || form.primaryIdentifierVariable || "";
  const value = identifier ? entryExportValue(entry?.answers || {}, { name: identifier }) : "";
  const formatted = csvValue(value);
  return String(formatted || (entry?.instanceName || entry?.id || "Unnamed response"));
}

function FolderVisualizationPage({ folderId }) {
  const [folder, setFolder] = useState(null);
  const [forms, setForms] = useState([]);
  const [status, setStatus] = useState({ kind: "busy", message: "Loading folder responses..." });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [positions, setPositions] = useState({});
  const [drag, setDrag] = useState(null);
  const [displayFieldByWorkspace, setDisplayFieldByWorkspace] = useState({});
  const [displayPanelForm, setDisplayPanelForm] = useState(null);
  const graphRef = useRef(null);

  async function loadVisualization() {
    setStatus({ kind: "busy", message: "Loading folder responses..." });
    try {
      const [folderData, formData] = await Promise.all([
        requestJson("/api/folders"),
        requestJson("/api/forms")
      ]);
      const nextFolder = (folderData.folders || []).find((item) => item.id === folderId);
      if (!nextFolder) throw new Error("Folder not found.");
      const selectedForms = visibleVersionForFolderForms(formData.forms || [], folderId);
      const enrichedForms = await Promise.all(selectedForms.map(async (form) => {
        const [entryData, draftData] = await Promise.all([
          requestJson(`/api/forms/${encodeURIComponent(form.workspaceId)}/entries`),
          requestJson(`/api/forms/${encodeURIComponent(form.workspaceId)}`)
        ]);
        return {
          ...form,
          entries: entryData.entries || [],
          draft: draftData.draft || {}
        };
      }));
      setFolder(nextFolder);
      setForms(enrichedForms);
      setDisplayFieldByWorkspace((current) => Object.fromEntries(enrichedForms.map((form) => [
        form.workspaceId,
        current[form.workspaceId] || form.participantIdentifierVariable || form.primaryIdentifierVariable || form.draft?.questions?.find((question) => question.name)?.name || ""
      ])));
      setStatus({ kind: "ok", message: `${enrichedForms.length} form${enrichedForms.length === 1 ? "" : "s"} loaded.` });
    } catch (error) {
      setStatus({ kind: "error", message: error.message || String(error) });
    }
  }

  async function downloadFolderWorkbook() {
    setStatus({ kind: "busy", message: "Preparing folder response workbook..." });
    try {
      const response = await fetch(`${API_BASE}/api/folders/${encodeURIComponent(folderId)}/responses.xlsx`, {
        headers: adminAuthHeaders()
      });
      if (!response.ok) {
        const text = await response.text();
        let message = text;
        try { message = JSON.parse(text).error || text; } catch {}
        throw new Error(message || "Folder workbook export failed.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const match = disposition.match(/filename="?([^";]+)"?/i);
      downloadBlob(blob, match?.[1] || safeDownloadName(`${folder?.name || "folder"}_responses.xlsx`, "folder_responses.xlsx"));
      setStatus({ kind: "ok", message: "Folder response workbook downloaded." });
    } catch (error) {
      setStatus({ kind: "error", message: error.message || String(error) });
    }
  }

  useEffect(() => {
    loadVisualization();
  }, [folderId]);

  const graph = useMemo(() => {
    const coreWidth = 230;
    const coreGap = 150;
    const coreY = 150;
    const childStartY = 310;
    const childGapX = 92;
    const childGapY = 86;
    const coreNodes = forms.map((form, index) => ({
      id: `form:${form.workspaceId}`,
      type: "core",
      form,
      x: 170 + index * (coreWidth + coreGap),
      y: coreY
    }));
    const responseNodes = [];
    for (const core of coreNodes) {
      const entries = core.form.entries || [];
      const columns = Math.max(1, Math.min(5, entries.length));
      entries.forEach((entry, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        responseNodes.push({
          id: `entry:${core.form.workspaceId}:${entry.id || index}`,
          type: "response",
          form: core.form,
          entry,
          x: core.x + (column - (columns - 1) / 2) * childGapX,
          y: childStartY + row * childGapY
        });
      });
    }
    return {
      coreNodes,
      responseNodes,
      width: Math.max(980, coreNodes.at(-1)?.x + coreWidth / 2 + 170 || 980),
      height: Math.max(560, ...responseNodes.map((node) => node.y + 80))
    };
  }, [forms]);

  useEffect(() => {
    setPositions((current) => {
      const next = { ...current };
      for (const node of [...graph.coreNodes, ...graph.responseNodes]) {
        if (!next[node.id]) next[node.id] = { x: node.x, y: node.y };
      }
      return next;
    });
  }, [graph]);

  useEffect(() => {
    if (!drag) return undefined;
    function move(event) {
      const dx = (event.clientX - drag.clientX) / zoom;
      const dy = (event.clientY - drag.clientY) / zoom;
      if (drag.nodeId) {
        setPositions((current) => {
          const next = { ...current };
          for (const [nodeId, origin] of Object.entries(drag.relatedOrigins)) {
            const weight = nodeId === drag.nodeId ? 1 : origin.weight;
            next[nodeId] = { x: origin.x + dx * weight, y: origin.y + dy * weight };
          }
          return next;
        });
      } else {
        setPan({ x: drag.origin.x + event.clientX - drag.clientX, y: drag.origin.y + event.clientY - drag.clientY });
      }
    }
    function stop() { setDrag(null); }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [drag, zoom]);

  function startPan(event) {
    if (event.target !== event.currentTarget) return;
    setDrag({ clientX: event.clientX, clientY: event.clientY, origin: pan, nodeId: null });
  }

  function startNodeDrag(event, node) {
    event.stopPropagation();
    const point = positions[node.id] || node;
    const relatedOrigins = {};
    const connectedResponseNodes = graph.responseNodes.filter((item) => item.form.workspaceId === node.form?.workspaceId);
    const connectedCoreNodes = graph.coreNodes.filter((item) => item.id !== node.id && (item.id === node.id || Math.abs(item.x - node.x) <= 430));
    for (const candidate of [...connectedResponseNodes, ...connectedCoreNodes]) {
      const candidatePoint = positions[candidate.id] || candidate;
      if (candidate.id !== node.id) relatedOrigins[candidate.id] = { ...candidatePoint, weight: candidate.type === "response" ? 0.82 : 0.2 };
    }
    relatedOrigins[node.id] = { ...point, weight: 1 };
    setDrag({ clientX: event.clientX, clientY: event.clientY, origin: point, nodeId: node.id, relatedOrigins });
  }

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setPositions({});
  }

  const nodePosition = (node) => positions[node.id] || node;
  const identifierLabel = folder?.participantIdentifierVariable || folder?.primaryIdentifierVariable || "shared identifier";
  const coreNodes = graph.coreNodes;

  return (
    <div className="app-shell folder-visualization-page">
      <header className="topbar home-topbar">
        <div className="topbar-actions">
          <button className="secondary topbar-home" type="button" onClick={() => window.close()}>
            <Home size={16} /> Close
          </button>
        </div>
        <div className="topbar-title">
          <h1>{folder?.name || "Folder visualization"}</h1>
          <p>Interactive response map for forms in this folder.</p>
        </div>
        <div className="topbar-brand"><BrandLogos /></div>
      </header>
      <main className="folder-visualization-main">
        <div className="folder-visualization-heading">
          <div>
            <span className="eyebrow">Folder responses</span>
            <h2>{folder?.name || "Loading folder..."}</h2>
            <p>Forms are linked by <strong>{identifierLabel}</strong>. Drag nodes to explore the relationship map.</p>
          </div>
          <div className="folder-graph-actions">
            <button className="primary small" type="button" onClick={downloadFolderWorkbook} disabled={status.kind === "busy"}><Download size={14} /> Download Excel</button>
            <button className="secondary small" type="button" onClick={loadVisualization} disabled={status.kind === "busy"}><RefreshCw size={14} /> Refresh</button>
            <button className="secondary small icon-only" type="button" onClick={() => setZoom((value) => Math.min(2.5, value + 0.15))} title="Zoom in"><ZoomIn size={16} /></button>
            <button className="secondary small icon-only" type="button" onClick={() => setZoom((value) => Math.max(0.45, value - 0.15))} title="Zoom out"><ZoomOut size={16} /></button>
            <button className="secondary small icon-only" type="button" onClick={resetView} title="Reset map"><Maximize2 size={16} /></button>
          </div>
        </div>
        <div className="folder-graph-legend">
          <span><i className="graph-legend-core" /> Form</span>
          <span><i className="graph-legend-response" /> Response</span>
          <span><Network size={14} /> Shared identifier link</span>
          {status.message ? <span className={`graph-status ${status.kind}`}>{status.message}</span> : null}
        </div>
        <div className="folder-graph-viewport" ref={graphRef} onPointerDown={startPan} onWheel={(event) => { event.preventDefault(); setZoom((value) => Math.max(0.45, Math.min(2.5, value * (event.deltaY > 0 ? 0.9 : 1.1)))); }}>
          {forms.length ? (
            <svg className="folder-graph-svg" width={graph.width} height={graph.height} viewBox={`0 0 ${graph.width} ${graph.height}`} role="img" aria-label={`Response graph for ${folder?.name || "folder"}`}>
              <defs>
                <pattern id="folder-graph-grid" width="32" height="32" patternUnits="userSpaceOnUse">
                  <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#e8edf5" strokeWidth="1" />
                </pattern>
                <marker id="folder-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M 0 0 L 8 4 L 0 8 z" fill="#93a4bf" />
                </marker>
              </defs>
              <rect width="100%" height="100%" fill="url(#folder-graph-grid)" />
              <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
                {coreNodes.slice(0, -1).map((node, index) => {
                  const next = coreNodes[index + 1];
                  const from = nodePosition(node);
                  const to = nodePosition(next);
                  const x1 = from.x + 115;
                  const x2 = to.x - 115;
                  const y = from.y;
                  return (
                    <g key={`link:${node.id}`}>
                      <line className="graph-core-edge" x1={x1} y1={y} x2={x2} y2={to.y} markerEnd="url(#folder-graph-arrow)" />
                      <text className="graph-edge-label" x={(x1 + x2) / 2} y={(y + to.y) / 2 - 8} textAnchor="middle">{identifierLabel}</text>
                    </g>
                  );
                })}
                {coreNodes.map((node) => {
                  const point = nodePosition(node);
                  return (graph.responseNodes.filter((item) => item.form.workspaceId === node.form.workspaceId)).map((child) => {
                    const childPoint = nodePosition(child);
                    const bend = Math.max(26, Math.abs(childPoint.x - point.x) * 0.28);
                    return <path className="graph-response-edge" key={`edge:${child.id}`} d={`M ${point.x} ${point.y + 46} C ${point.x} ${point.y + 46 + bend}, ${childPoint.x} ${childPoint.y - bend}, ${childPoint.x} ${childPoint.y - 28}`} />;
                  });
                })}
                {coreNodes.map((node) => {
                  const point = nodePosition(node);
                  const demographic = Boolean(node.form.draft?.questions?.some((question) => question.type === "begin_repeat" && question.demographicData));
                  return (
                    <g className="graph-core-node" key={node.id} transform={`translate(${point.x - 115} ${point.y - 46})`} onPointerDown={(event) => startNodeDrag(event, node)}>
                      <rect width="230" height="92" rx="18" />
                      <text className="graph-core-title" x="18" y="32">{String(node.form.title || "Untitled form").length > 22 ? `${String(node.form.title || "Untitled form").slice(0, 21)}…` : (node.form.title || "Untitled form")}</text>
                      <text className="graph-core-subtitle" x="18" y="57">v{node.form.versionNumber || 1} · {node.form.entries?.length || 0} responses{demographic ? " · DEMOGRAPHIC" : ""}</text>
                      <text className="graph-display-link" x="18" y="79" onPointerDown={(event) => event.stopPropagation()} onClick={() => setDisplayPanelForm(node.form)}>display variable</text>
                    </g>
                  );
                })}
                {graph.responseNodes.map((node) => {
                  const point = nodePosition(node);
                  const label = folderVisualizationResponseValue(node.entry, node.form, displayFieldByWorkspace[node.form.workspaceId]);
                  return (
                    <g className="graph-response-node" key={node.id} transform={`translate(${point.x} ${point.y})`} onPointerDown={(event) => startNodeDrag(event, node)}>
                      <circle r="28" />
                      <text x="0" y="4" textAnchor="middle" textLength="42" lengthAdjust="spacingAndGlyphs">{label.length > 8 ? `${label.slice(0, 7)}…` : label}</text>
                      <title>{label}</title>
                    </g>
                  );
                })}
              </g>
            </svg>
          ) : (
            <div className="folder-graph-empty"><Network size={34} /><p>No forms or responses are available in this folder yet.</p></div>
          )}
        </div>
        {displayPanelForm ? (
          <aside className="folder-display-drawer" aria-label="Choose display variable">
            <div className="folder-display-drawer-head">
              <div>
                <span className="eyebrow">Response labels</span>
                <h3>Display variable</h3>
                <p>{displayPanelForm.title || "Selected form"}</p>
              </div>
              <button className="icon-button small" type="button" onClick={() => setDisplayPanelForm(null)} aria-label="Close display variable panel"><X size={16} /></button>
            </div>
            <label className="field">
              <span>Question used for response circles</span>
              <select
                value={displayFieldByWorkspace[displayPanelForm.workspaceId] || ""}
                onChange={(event) => setDisplayFieldByWorkspace((current) => ({ ...current, [displayPanelForm.workspaceId]: event.target.value }))}
              >
                {entryCsvQuestions(displayPanelForm.draft).map((question) => (
                  <option key={question.id || question.name} value={question.name}>{displayFormText(question.label || question.name) || question.name} ({question.name})</option>
                ))}
              </select>
            </label>
            <p className="folder-display-drawer-note">Changing this only changes the labels shown in this visualization. Form data is not modified.</p>
          </aside>
        ) : null}
      </main>
    </div>
  );
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
  const [respondentSession, setRespondentSession] = useState(null);
  const [status, setStatus] = useState({ kind: message ? "ok" : "idle", message });
  const canAdminLogin = password.trim().length > 0 && status.kind !== "busy";

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

  function openRespondentSession(session) {
    setRespondentSession(session);
    setStatus({ kind: "idle", message: "" });
    window.history.replaceState(null, "", `/respondent/${encodeURIComponent(session.accessCode)}`);
  }

  if (respondentSession) {
    return (
      <FillForm
        accessCode={respondentSession.accessCode}
        checkpointAnswers={respondentSession.checkpoint?.answers || null}
        resumePrimaryIdentifierValue={respondentSession.primaryIdentifierValue || ""}
        onBackToRespondent={() => {
          setRespondentSession(null);
          setStatus({ kind: "idle", message: "" });
          window.history.replaceState(null, "", "/");
        }}
      />
    );
  }

  return (
    <div className="access-shell">
      <main className="access-card">
        <div className="access-head">
          <div>
            <h1>ICPH Forms</h1>
            <p>Choose how you want to continue.</p>
          </div>
          <BrandLogos variant="access" />
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
          <button
            className={`access-role-button ${activeRole === "field-agent" ? "active" : ""}`}
            aria-expanded={activeRole === "field-agent"}
            type="button"
            onClick={() => selectRole("field-agent")}
          >
            <span>Field Agent</span>
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
            <RespondentAccessPanel onOpen={openRespondentSession} />
          ) : null}

          {activeRole === "field-agent" ? (
            <div className="access-panel access-panel-open">
              <div>
                <h2>Field Agent</h2>
                <p>Review published forms and submitted entries.</p>
              </div>
              <button className="primary" type="button" onClick={() => window.location.assign("/field-agent")}>
                <Forward size={16} /> Enter
              </button>
            </div>
          ) : null}

          {!activeRole ? (
            <div className="access-empty-hint">
              <p>Select a role to continue.</p>
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
  const [session, setSession] = useState(() => {
    const code = normalizeAccessCodeInput(initialCode);
    return code.length ? { accessCode: code, mode: "fresh" } : null;
  });
  const [status, setStatus] = useState({ kind: "idle", message: "" });

  function openSession(nextSession) {
    setSession(nextSession);
    setStatus({ kind: "idle", message: "" });
    window.history.replaceState(null, "", `/respondent/${encodeURIComponent(nextSession.accessCode)}`);
  }

  if (session?.accessCode) {
    return (
      <FillForm
        accessCode={session.accessCode}
        checkpointAnswers={session.checkpoint?.answers || null}
        resumePrimaryIdentifierValue={session.primaryIdentifierValue || ""}
        onBackToRespondent={() => {
          setSession(null);
          setStatus({ kind: "idle", message: "" });
          window.history.replaceState(null, "", "/respondent");
        }}
      />
    );
  }

  return (
    <div className="access-shell respondent-only">
      <main className="access-card respondent-code-card">
        <div className="access-head">
          <div>
            <h1>ICPH Form</h1>
            <p>Enter the form code shared by the study team.</p>
          </div>
          <BrandLogos variant="access" />
        </div>
        <RespondentAccessPanel initialCode={initialCode} onOpen={openSession} />
        <PwaInstallButton />
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

function PwaInstallButton() {
  const [installPrompt, setInstallPrompt] = useState(null);
  useEffect(() => {
    const capturePrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const clearPrompt = () => setInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", capturePrompt);
    window.addEventListener("appinstalled", clearPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", capturePrompt);
      window.removeEventListener("appinstalled", clearPrompt);
    };
  }, []);
  if (!installPrompt) return null;
  return (
    <button className="secondary small pwa-install-button" type="button" onClick={async () => {
      await installPrompt.prompt();
      setInstallPrompt(null);
    }}>
      <Download size={16} /> Install app
    </button>
  );
}

function FieldAgentPortal() {
  const [forms, setForms] = useState([]);
  const [selectedCode, setSelectedCode] = useState("");
  const [displayFieldByCode, setDisplayFieldByCode] = useState({});
  const [selectedEntryIds, setSelectedEntryIds] = useState([]);
  const [status, setStatus] = useState({ kind: "busy", message: "Loading published forms..." });
  const selectedForm = forms.find((item) => item.respondentAccessCode === selectedCode) || forms[0] || null;
  const fieldAgentEntryIds = useMemo(
    () => (selectedForm?.entries || []).map((entry) => String(entry.id || "")).filter(Boolean),
    [selectedForm?.entries]
  );
  const fieldAgentSelectedSet = useMemo(() => new Set(selectedEntryIds), [selectedEntryIds]);
  const fieldAgentDisplayOptions = selectedForm?.displayFields || [];
  const fieldAgentDisplayField = displayFieldByCode[selectedForm?.respondentAccessCode]
    || selectedForm?.participantIdentifierVariable
    || selectedForm?.primaryIdentifierVariable
    || fieldAgentDisplayOptions[0]?.name
    || "";
  const fieldAgentAllSelected = fieldAgentEntryIds.length > 0 && selectedEntryIds.length === fieldAgentEntryIds.length;

  async function loadPublishedForms() {
    setStatus({ kind: "busy", message: "Loading published forms..." });
    try {
      const data = await requestJson("/api/public/forms");
      const nextForms = data.forms || [];
      setForms(nextForms);
      setSelectedCode((current) => nextForms.some((item) => item.respondentAccessCode === current)
        ? current
        : nextForms[0]?.respondentAccessCode || "");
      setStatus({ kind: "ok", message: nextForms.length ? "Ready." : "No published forms available." });
    } catch (error) {
      const savedForms = await listOfflineFormPackages().catch(() => []);
      if (savedForms.length) {
        setForms(savedForms.map((item) => ({ ...item, respondentAccessCode: item.accessCode })));
        setSelectedCode((current) => savedForms.some((item) => item.accessCode === current)
          ? current
          : savedForms[0]?.accessCode || "");
        setStatus({ kind: "ok", message: "Offline. Saved forms are available; entries will load when you reconnect." });
      } else {
        setStatus({ kind: "error", message: error.message || String(error) });
      }
    }
  }

  useEffect(() => {
    loadPublishedForms();
  }, []);

  useEffect(() => {
    setSelectedEntryIds([]);
  }, [selectedForm?.respondentAccessCode]);

  useEffect(() => {
    function handleCollectionSignal(event) {
      if (event?.type === "storage" && event.key !== "icph_collection_changed_at") return;
      if (event?.type === "message" && event.data?.type !== "icph:collection-changed") return;
      loadPublishedForms();
    }
    window.addEventListener("storage", handleCollectionSignal);
    window.addEventListener("message", handleCollectionSignal);
    window.addEventListener("focus", handleCollectionSignal);
    return () => {
      window.removeEventListener("storage", handleCollectionSignal);
      window.removeEventListener("message", handleCollectionSignal);
      window.removeEventListener("focus", handleCollectionSignal);
    };
  }, []);

  function openFillForm(form, entryId = "") {
    const code = normalizeAccessCodeInput(form?.respondentAccessCode);
    if (!code) return;
    const query = entryId ? `?entryId=${encodeURIComponent(entryId)}` : "";
    window.open(`/public-fill/${encodeURIComponent(code)}${query}`, "_blank");
  }

  function toggleFieldAgentEntry(entryId, checked) {
    setSelectedEntryIds((current) => checked
      ? [...new Set([...current, entryId])]
      : current.filter((id) => id !== entryId));
  }

  async function deleteFieldAgentEntries(entryIds) {
    const ids = (Array.isArray(entryIds) ? entryIds : [entryIds]).filter(Boolean);
    const code = normalizeAccessCodeInput(selectedForm?.respondentAccessCode);
    if (!ids.length || !code) return;
    const confirmed = window.confirm(`Delete ${ids.length} entr${ids.length === 1 ? "y" : "ies"}? This cannot be undone.`);
    if (!confirmed) return;
    setStatus({ kind: "busy", message: "Deleting entries..." });
    try {
      await deleteJson(`/api/public/forms/${encodeURIComponent(code)}/entries`, { entryIds: ids });
      setSelectedEntryIds([]);
      notifyCollectionChanged();
      await loadPublishedForms();
      setStatus({ kind: "ok", message: `Deleted ${ids.length} entr${ids.length === 1 ? "y" : "ies"}.` });
    } catch (error) {
      setStatus({ kind: "error", message: error.message || String(error) });
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar field-agent-topbar">
        <div className="topbar-actions">
          <button className="secondary topbar-home" onClick={() => window.location.assign("/")}>
            <Home size={18} /> Home
          </button>
        </div>
        <div className="topbar-title">
          <h1>Field Agent</h1>
          <p>Published form collection</p>
        </div>
        <div className="topbar-brand">
          <BrandLogos />
        </div>
      </header>
      <main className="field-agent-layout">
        <aside className="field-agent-sidebar">
          <div className="section-head compact">
            <h2>Forms</h2>
            <button className="secondary small" onClick={loadPublishedForms}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
          <div className="field-agent-form-list">
            {forms.map((formItem) => (
              <button
                key={formItem.respondentAccessCode}
                className={`field-agent-form-button ${selectedForm?.respondentAccessCode === formItem.respondentAccessCode ? "active" : ""}`}
                onClick={() => setSelectedCode(formItem.respondentAccessCode)}
                type="button"
              >
                <span>{formItem.title}</span>
                <strong>{formItem.respondentAccessCode}</strong>
                <small>{formItem.entryCount || 0} entries</small>
              </button>
            ))}
          </div>
        </aside>
        <section className="field-agent-main">
          {selectedForm ? (
            <>
              <div className="field-agent-title-row">
                <div>
                  <h2>{selectedForm.title}</h2>
                  <p>{selectedForm.formId || selectedForm.workspaceId}</p>
                </div>
                <button className="primary" onClick={() => openFillForm(selectedForm)}>
                  <ExternalLink size={16} /> Fill Form
                </button>
                {fieldAgentDisplayOptions.length ? (
                  <label className="display-field-select">
                    <span>Display</span>
                    <select
                      value={fieldAgentDisplayField}
                      onChange={(event) => setDisplayFieldByCode((current) => ({
                        ...current,
                        [selectedForm.respondentAccessCode]: event.target.value
                      }))}
                    >
                      {fieldAgentDisplayOptions.map((option) => (
                        <option key={option.name} value={option.name}>{displayFormText(option.label || option.name) || option.name}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              <div className="panel entries-panel field-agent-entries">
                <div className="section-head">
                  <h2>Entries</h2>
                  <span>{selectedForm.entries?.length || 0} submissions</span>
                </div>
                {selectedForm.entries?.length ? (
                  <div className="entries-table">
                    <label className="bulk-check-row">
                      <input
                        type="checkbox"
                        checked={fieldAgentAllSelected}
                        onChange={(event) => setSelectedEntryIds(event.target.checked ? fieldAgentEntryIds : [])}
                      />
                      <span>{selectedEntryIds.length}/{selectedForm.entries.length} selected</span>
                      <button className="secondary small danger-action" disabled={!selectedEntryIds.length || status.kind === "busy"} onClick={() => deleteFieldAgentEntries(selectedEntryIds)}>
                        <Trash2 size={14} /> Delete
                      </button>
                    </label>
                    {selectedForm.entries.slice().reverse().map((entry) => (
                      <div className="entry-row field-agent-entry-row" key={entry.id}>
                        <label className="row-check">
                          <input
                            type="checkbox"
                            checked={fieldAgentSelectedSet.has(String(entry.id || ""))}
                            onChange={(event) => toggleFieldAgentEntry(String(entry.id || ""), event.target.checked)}
                          />
                          <span className="sr-only">Select entry {entryDisplayValue(entry, fieldAgentDisplayField)}</span>
                        </label>
                        <div>
                          <span>{entryDisplayValue(entry, fieldAgentDisplayField)}</span>
                          <small>
                            {new Date(entry.submittedAt).toLocaleString()}
                            {entry.updatedAt ? ` · updated ${new Date(entry.updatedAt).toLocaleString()}` : ""}
                          </small>
                        </div>
                        <div className="entry-actions">
                          {selectedForm.responseSettings?.allowResponseEdits ? (
                            <button className="secondary small icon-text-button" onClick={() => openFillForm(selectedForm, entry.id)} title="Edit entry">
                              <TextCursorInput size={14} /> Edit
                            </button>
                          ) : null}
                          <button className="secondary small danger-action" disabled={status.kind === "busy"} onClick={() => deleteFieldAgentEntries([entry.id])}>
                            <Trash2 size={14} /> Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">No submissions yet.</p>
                )}
              </div>
            </>
          ) : (
            <div className="panel empty-state tall">
              <ClipboardList size={36} />
              <p>No published forms yet.</p>
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
    </div>
  );
}

function primaryIdentifierQuestionText(form = {}) {
  const variable = String(form?.participantIdentifierVariable || form?.primaryIdentifierVariable || "").trim();
  if (!variable) return "";
  const question = (form.questions || []).find((item) => item.name === variable);
  const label = displayFormText(question?.label || question?.hint || "");
  return label || "Primary identifier question";
}

function RespondentAccessPanel({ initialCode = "", onOpen }) {
  const [mode, setMode] = useState("fresh");
  const [code, setCode] = useState(normalizeAccessCodeInput(initialCode));
  const [resumeIdentifierValue, setResumeIdentifierValue] = useState("");
  const [formInfo, setFormInfo] = useState(null);
  const [offlineForms, setOfflineForms] = useState([]);
  const [status, setStatus] = useState({ kind: "idle", message: "" });
  const normalizedCode = normalizeAccessCodeInput(code);
  const primaryIdentifierVariable = formInfo?.draft?.participantIdentifierVariable || formInfo?.draft?.primaryIdentifierVariable || "";
  const primaryIdentifierQuestion = primaryIdentifierQuestionText(formInfo?.draft);
  const canFresh = normalizedCode.length > 0 && status.kind !== "busy";
  const canResume = normalizedCode.length > 0 && resumeIdentifierValue.trim() && status.kind !== "busy";

  useEffect(() => {
    let cancelled = false;
    listOfflineFormPackages().then((items) => {
      if (!cancelled) setOfflineForms(items);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFormInfo(null);
    setResumeIdentifierValue("");
    if (mode !== "resume" || !normalizedCode.length) return undefined;
    setStatus({ kind: "busy", message: "Loading form details..." });
    requestJson(`/api/public/forms/${encodeURIComponent(normalizedCode)}`)
      .then((data) => {
        if (cancelled) return;
        setFormInfo(data);
        const identifier = data?.draft?.participantIdentifierVariable || data?.draft?.primaryIdentifierVariable || "";
        const identifierQuestion = primaryIdentifierQuestionText(data?.draft);
        setStatus({
          kind: identifier ? "ok" : "error",
          message: identifier ? `Enter ${identifierQuestion} to continue.` : "This form does not have a primary identifier variable."
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus({ kind: "error", message: error.message || String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [mode, normalizedCode]);

  function chooseMode(nextMode) {
    setMode(nextMode);
    setStatus({ kind: "idle", message: "" });
    setFormInfo(null);
    setResumeIdentifierValue("");
  }

  function openFresh(event) {
    event.preventDefault();
    if (!canFresh) return;
    onOpen({ accessCode: normalizedCode, mode: "fresh" });
  }

  async function openCheckpoint(event) {
    event.preventDefault();
    if (!canResume) return;
    setStatus({ kind: "busy", message: "Finding saved checkpoint..." });
    try {
      const data = await requestJson(`/api/public/forms/${encodeURIComponent(normalizedCode)}/checkpoint`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ primaryIdentifierValue: resumeIdentifierValue })
      });
      if (!data.checkpoint) {
        setStatus({ kind: "error", message: "No saved checkpoint was found for that identifier." });
        return;
      }
      onOpen({
        accessCode: normalizedCode,
        mode: "resume",
        primaryIdentifierValue: data.primaryIdentifierValue,
        checkpoint: data.checkpoint
      });
    } catch (error) {
      try {
        const offlinePackage = await loadOfflineFormPackage(normalizedCode);
        const draft = offlinePackage?.draft || {};
        const identifier = draft.participantIdentifierVariable || draft.primaryIdentifierVariable || "";
        const localDraft = await readEncryptedOfflineRecords("offlineDrafts");
        const saved = localDraft.find((item) => item.id === offlineDraftId(normalizedCode) && String(item.answers?.[identifier] || "").trim() === resumeIdentifierValue.trim());
        if (!saved) throw error;
        onOpen({
          accessCode: normalizedCode,
          mode: "resume",
          primaryIdentifierValue: resumeIdentifierValue.trim(),
          checkpoint: { answers: saved.answers }
        });
      } catch (offlineError) {
        setStatus({ kind: "error", message: offlineError.message || error.message || String(error) });
      }
    }
  }

  return (
    <div className="access-panel access-panel-open respondent-panel respondent-access-flow">
      <div className="access-role-tabs respondent-mode-tabs" aria-label="Choose respondent action">
        <button
          className={`access-role-button ${mode === "fresh" ? "active" : ""}`}
          type="button"
          onClick={() => chooseMode("fresh")}
        >
          <span>Fill a fresh form</span>
          <FileText size={18} />
        </button>
        <button
          className={`access-role-button ${mode === "resume" ? "active" : ""}`}
          type="button"
          onClick={() => chooseMode("resume")}
        >
          <span>Continue old form</span>
          <RefreshCw size={18} />
        </button>
      </div>

      {mode === "fresh" ? (
        <form className="respondent-code-form" onSubmit={openFresh}>
          <div>
            <h2>Respondent</h2>
            <p>Enter the form code shared by the study team.</p>
          </div>
          <label className="field">
            <span>Form code</span>
            <input
              className="access-code-input"
              value={code}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={RESPONDENT_CODE_MAX_LENGTH}
              autoFocus
              onChange={(event) => setCode(normalizeAccessCodeInput(event.target.value))}
              placeholder="A1B2C"
            />
          </label>
          {offlineForms.length ? (
            <label className="field offline-form-choice">
              <span>Available on this device</span>
              <select value={offlineForms.some((item) => item.accessCode === normalizedCode) ? normalizedCode : ""} onChange={(event) => setCode(event.target.value)}>
                <option value="">Choose a saved form</option>
                {offlineForms.map((item) => <option key={item.accessCode} value={item.accessCode}>{item.title || item.formId || item.accessCode} ({item.accessCode})</option>)}
              </select>
            </label>
          ) : null}
          <button className="secondary" disabled={!canFresh} type="submit">
            <Forward size={16} /> Fill Form
          </button>
        </form>
      ) : (
        <form className="respondent-code-form" onSubmit={openCheckpoint}>
          <div>
            <h2>Respondent</h2>
            <p>Enter the form code, then identify the saved checkpoint.</p>
          </div>
          <label className="field">
            <span>Form code</span>
            <input
              className="access-code-input"
              value={code}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={RESPONDENT_CODE_MAX_LENGTH}
              autoFocus
              onChange={(event) => setCode(normalizeAccessCodeInput(event.target.value))}
              placeholder="A1B2C"
            />
          </label>
          <label className="field">
            <span>{primaryIdentifierQuestion || "Primary identifier question"}</span>
            <input
              value={resumeIdentifierValue}
              disabled={!normalizedCode.length || status.kind === "busy" || !primaryIdentifierVariable}
              onChange={(event) => setResumeIdentifierValue(event.target.value)}
              placeholder={primaryIdentifierQuestion ? "Enter your answer" : "Enter form code first"}
            />
          </label>
          <button className="secondary" disabled={!canResume || !primaryIdentifierVariable} type="submit">
            <Forward size={16} /> Continue Form
          </button>
        </form>
      )}

      {status.message ? (
        <div className={`status-line ${status.kind}`}>
          {status.kind === "ok" ? <Check size={16} /> : <AlertCircle size={16} />}
          <span>{status.message}</span>
        </div>
      ) : null}
    </div>
  );
}

function DashboardApp({ onLogout }) {
  const [view, setView] = useState("home");
  const [forms, setForms] = useState([]);
  const [folders, setFolders] = useState([]);
  const [schemaDocuments, setSchemaDocuments] = useState([]);
  const [schemaSummary, setSchemaSummary] = useState(null);
  const [pendingXlsxImport, setPendingXlsxImport] = useState(null);
  const [folderFormPrompt, setFolderFormPrompt] = useState(null);
  const [newFormPromptOpen, setNewFormPromptOpen] = useState(false);
  const [publishIdentifierPrompt, setPublishIdentifierPrompt] = useState(false);
  const [publishConfirmationAccepted, setPublishConfirmationAccepted] = useState(false);
  const [respondentCodeMode, setRespondentCodeMode] = useState(RESPONDENT_CODE_MODE_RANDOM);
  const [customRespondentCode, setCustomRespondentCode] = useState("");
  const [allowResponseEdits, setAllowResponseEdits] = useState(false);
  const [limitOneResponsePerIdentifier, setLimitOneResponsePerIdentifier] = useState(true);
  const [participantIdentifierVariable, setParticipantIdentifierVariable] = useState("");
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
  const currentFolder = useMemo(
    () => folders.find((folder) => folder.id === form.folderId) || null,
    [folders, form.folderId]
  );
  const folderBarcodeQuestion = useMemo(
    () => (form.questions || []).find((question) => question?.type === "barcode" && String(question.name || "").trim()) || null,
    [form.questions]
  );
  const folderPrimaryIdentifier = currentFolder?.primaryIdentifierVariable
    || forms.find((item) => item.folderId === form.folderId && item.primaryIdentifierVariable)?.primaryIdentifierVariable
    || "";
  const needsFolderPrimaryAcknowledgement = Boolean(form.folderId && !folderPrimaryIdentifier);
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

  async function refreshFolders() {
    const data = await requestJson("/api/folders");
    setFolders(data.folders || []);
  }

  async function createFolder() {
    const name = window.prompt("Folder name");
    if (!name?.trim()) return;
    try {
      const data = await postJson("/api/folders", { name: name.trim() });
      setFolders(data.folders || []);
      setStatus({ kind: "ok", message: `Created folder: ${name.trim()}` });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function deleteFolder(folderId, name) {
    const confirmed = await requestConfirmation({
      title: "Delete Folder?",
      message: `Delete "${name || folderId}" and every form inside it? This permanently removes the folder's forms, entries, XLSForms, XML, and FHIR bundles.`,
      confirmLabel: "Delete",
      confirmIcon: "trash",
      danger: true
    });
    if (!confirmed) return;
    setStatus({ kind: "busy", message: "Deleting folder and its forms..." });
    try {
      const data = await deleteJson(`/api/folders/${encodeURIComponent(folderId)}`);
      if (data.deletedWorkspaceIds?.some((id) => workspaceRouteId(workspace?.workspaceId) === workspaceRouteId(id))) {
        setWorkspace(null);
        setForm(defaultForm());
        setEntries([]);
        setAttachments([]);
        setFhirBundles([]);
        setTerminology({ status: "not_started", questions: [] });
        setSelectedId(null);
        setView("home");
      }
      setFolders(data.folders || []);
      await refreshForms();
      setStatus({ kind: "ok", message: `Deleted folder: ${name || folderId}` });
    } catch (error) {
      handleRequestError(error);
    }
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
    refreshFolders().catch(handleRequestError);
    refreshSchemaDocuments().catch(handleRequestError);
  }, []);

  useEffect(() => {
    if (workspace?.respondentAccessCode) {
      const savedMode = form.respondentCodeMode === RESPONDENT_CODE_MODE_CUSTOM
        ? RESPONDENT_CODE_MODE_CUSTOM
        : RESPONDENT_CODE_MODE_RANDOM;
      setRespondentCodeMode(savedMode);
      setCustomRespondentCode(normalizeAccessCodeInput(workspace.respondentAccessCode));
    } else {
      setRespondentCodeMode(RESPONDENT_CODE_MODE_RANDOM);
      setCustomRespondentCode("");
    }
  }, [form.respondentCodeMode, workspace?.workspaceId, workspace?.respondentAccessCode]);

  useEffect(() => {
    setAllowResponseEdits(Boolean(form.allowResponseEdits));
    setLimitOneResponsePerIdentifier(form.limitOneResponsePerIdentifier !== false);
    setParticipantIdentifierVariable(
      form.participantIdentifierVariable
      || (currentFolder?.participantIdentifierMode === "barcode" ? folderBarcodeQuestion?.name : "")
      || form.primaryIdentifierVariable
      || ""
    );
  }, [form.allowResponseEdits, form.limitOneResponsePerIdentifier, form.participantIdentifierVariable, form.primaryIdentifierVariable, currentFolder?.participantIdentifierMode, folderBarcodeQuestion?.name, workspace?.workspaceId]);

  async function updateResponseSettings(nextSettings) {
    const merged = {
      allowResponseEdits,
      limitOneResponsePerIdentifier,
      participantIdentifierVariable: participantIdentifierVariable || form.primaryIdentifierVariable || "",
      ...nextSettings
    };
    setAllowResponseEdits(Boolean(merged.allowResponseEdits));
    setLimitOneResponsePerIdentifier(merged.limitOneResponsePerIdentifier !== false);
    setParticipantIdentifierVariable(merged.participantIdentifierVariable || form.primaryIdentifierVariable || "");
    setForm((current) => ({ ...current, ...merged }));
    if (!workspace?.workspaceId || !hasPublishedForm(workspace)) return;
    setStatus({ kind: "busy", message: "Saving response settings..." });
    try {
      const data = await requestJson(`/api/forms/${encodeURIComponent(workspaceRouteId(workspace.workspaceId))}/response-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(merged)
      });
      setWorkspace((current) => ({ ...current, ...data }));
      setForm(normalizeFormDraft(data.draft));
      await refreshForms();
      setStatus({ kind: "ok", message: "Response settings saved." });
    } catch (error) {
      handleRequestError(error);
    }
  }

  function updateTerminologyLlm() {
    setForm((current) => ({ ...current, terminologyUseLlm: false }));
  }

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
    setForm((current) => {
      const target = current.questions.find((question) => question.id === id);
      const nextQuestions = current.questions.map((question) => (question.id === id ? { ...question, ...patch } : question));
      if (!target || target.type !== "begin_repeat" || !Object.prototype.hasOwnProperty.call(patch, "demographicData")) {
        return { ...current, questions: nextQuestions };
      }
      const nextTarget = nextQuestions.find((question) => question.id === id);
      const targetIndex = nextQuestions.findIndex((question) => question.id === id);
      const next = [...nextQuestions];
      const childIndex = targetIndex + 1;
      const endIndex = findRepeatEnd(next, targetIndex);
      const existingGeneratedIndex = next.findIndex((question, index) => index > targetIndex && index < endIndex && question.demographicGeneratedId);
      if (nextTarget.demographicData && existingGeneratedIndex < 0) {
        const names = new Set(next.map((question) => question.name).filter(Boolean));
        let name = "member_id";
        let suffix = 2;
        while (names.has(name)) name = `member_id_${suffix++}`;
        next.splice(childIndex, 0, demographicMemberIdQuestion(name));
      } else if (!nextTarget.demographicData && existingGeneratedIndex >= 0) {
        next.splice(existingGeneratedIndex, 1);
      }
      return { ...current, questions: next };
    });
  }

  function addQuestion(type) {
    const question = newQuestion(type, form.questions.length);
    setForm((current) => ({ ...current, questions: [...current.questions, question] }));
    setSelectedId(question.id);
    setStatus({ kind: "ok", message: `Added ${questionTypeLabel(type)} as question ${form.questions.length + 1}!` });
  }

  function removeQuestion(id) {
    const question = form.questions.find((item) => item.id === id);
    if (question?.identifierLocked) {
      setStatus({ kind: "error", message: "This shared folder identifier is locked and cannot be deleted." });
      return;
    }
    if (question?.demographicGeneratedId && isDemographicGeneratedIdLocked(form.questions, id)) {
      setStatus({ kind: "error", message: "Turn off Demographic data before deleting its generated ID question." });
      return;
    }
    const label = questionNumberLabel(form, id);
    setForm((current) => ({ ...current, questions: current.questions.filter((question) => question.id !== id) }));
    setSelectedId((current) => (current === id ? null : current));
    setStatus({ kind: "ok", message: `Deleted ${label}.` });
  }

  function duplicateQuestion(question) {
    if (question.identifierLocked) {
      setStatus({ kind: "error", message: "This shared folder identifier is locked and cannot be duplicated." });
      return;
    }
    if (question.demographicGeneratedId) {
      setStatus({ kind: "error", message: "The generated demographic ID question cannot be duplicated." });
      return;
    }
    const sourceLabel = questionNumberLabel(form, question.id);
    const nextNumber = form.questions.length + 1;
    const copy = {
      ...question,
      id: crypto.randomUUID(),
      name: slug(`${question.name}_copy`),
      demographicGeneratedId: question.demographicGeneratedId ? false : question.demographicGeneratedId,
      demographicAutoGenerated: false,
      options: question.options?.map((option) => ({ ...option, id: crypto.randomUUID() }))
    };
    setForm((current) => ({ ...current, questions: [...current.questions, copy] }));
    setSelectedId(copy.id);
    setStatus({ kind: "ok", message: `Duplicated ${sourceLabel} as question ${nextNumber}.` });
  }

  function moveQuestion(targetId) {
    if (!draggedId || draggedId === targetId) return;
    const draggedQuestion = (form.questions || []).find((question) => question.id === draggedId);
    const targetQuestion = (form.questions || []).find((question) => question.id === targetId);
    if (draggedQuestion?.identifierLocked || targetQuestion?.identifierLocked) {
      setStatus({ kind: "error", message: "Shared folder identifiers stay in a fixed position." });
      return;
    }
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
    const safeLinkage = linkage && typeof linkage === "object" && !linkage.nativeEvent ? linkage : {};
    setStatus({ kind: "busy", message: "Creating form workspace..." });
    try {
      const data = await postJson("/api/forms/new", {
        title: "Untitled ICPH Form",
        formId: "icph_form",
        version: "1",
        linkedMetaFormFileName: safeLinkage.linkedMetaFormFileName,
        primaryIdentifierVariable: safeLinkage.primaryIdentifierVariable,
        metaFormFormIndex: safeLinkage.metaFormFormIndex,
        metaFormFormTitle: safeLinkage.metaFormFormTitle,
        folderId: safeLinkage.folderId,
        primaryIdentifierAcknowledged: safeLinkage.primaryIdentifierAcknowledged
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
        title: "Publish?",
        message: "After this point, the terminology review will be locked and vocabulary mappings cannot be edited. The form will move into local collection.",
        details: form.previousVersionWorkspaceId
          ? [
              `Version ${form.versionNumber || form.version || ""} changes:`,
              ...(copiedVersionChanges.length ? copiedVersionChanges : ["No detected build changes"]).slice(0, 12)
            ]
          : [],
        confirmLabel: "Publish",
        confirmIcon: "forward"
      });
      if (!confirmed) return;
    }
    const explicitPrimaryIdentifier = typeof primaryIdentifierVariable === "string" ? primaryIdentifierVariable : "";
    const selectedPrimaryIdentifier = String(explicitPrimaryIdentifier || form.primaryIdentifierVariable || "").trim();
    const folderUsesBarcodeIdentifier = currentFolder?.participantIdentifierMode === "barcode";
    if (form.folderId && folderPrimaryIdentifier && selectedPrimaryIdentifier && selectedPrimaryIdentifier !== folderPrimaryIdentifier && !folderUsesBarcodeIdentifier) {
      setStatus({ kind: "error", message: `Forms in this folder must use the shared primary identifier variable "${folderPrimaryIdentifier}".` });
      return;
    }
    const selectedRespondentCode = respondentCodeMode === RESPONDENT_CODE_MODE_CUSTOM
      ? normalizeAccessCodeInput(customRespondentCode)
      : "";
    if (!alreadyPublished && respondentCodeMode === RESPONDENT_CODE_MODE_CUSTOM && !selectedRespondentCode.length) {
      setActiveStage("publish");
      setStatus({ kind: "error", message: "Enter a custom respondent form code before publishing." });
      return;
    }
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
    const demographicIssue = demographicRepeatIssue(form, selectedPrimaryIdentifier);
    if (demographicIssue) {
      setActiveStage("build");
      setStatus({ kind: "error", message: demographicIssue });
      return;
    }
    const resolvedDemographicForm = resolveDemographicRepeats(form, selectedPrimaryIdentifier);
	    const formForExport = selectedPrimaryIdentifier
	      ? {
	          ...resolvedDemographicForm,
	          primaryIdentifierVariable: selectedPrimaryIdentifier,
	          instanceName: instanceNameForPrimaryIdentifier(selectedPrimaryIdentifier),
	          versionChangeSummary: copiedVersionChanges,
	          respondentCodeMode,
	          allowResponseEdits,
	          limitOneResponsePerIdentifier,
	          ...(selectedRespondentCode ? { respondentAccessCode: selectedRespondentCode } : {}),
	          ...(options.primaryIdentifierAcknowledged ? { primaryIdentifierAcknowledged: true } : {})
	        }
	      : {
	          ...resolvedDemographicForm,
	          versionChangeSummary: copiedVersionChanges,
	          respondentCodeMode,
	          allowResponseEdits,
	          limitOneResponsePerIdentifier,
	          ...(selectedRespondentCode ? { respondentAccessCode: selectedRespondentCode } : {}),
	          ...(options.primaryIdentifierAcknowledged ? { primaryIdentifierAcknowledged: true } : {})
	        };
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
        questionIds: selectedQuestionIds,
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
      setActiveStage("publish");
      setStatus({ kind: "ok", message: "Terminology marked unmapped. Choose the respondent code settings, then move to Publish." });
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

  async function importXlsx(event, folderId = "") {
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
        variableCount: data.variableCount || 0,
        folderId: String(folderId || "").trim() || "",
        folderName: folders.find((folder) => folder.id === folderId)?.name || "",
        folderPrimaryIdentifier: folders.find((folder) => folder.id === folderId)?.primaryIdentifierVariable
          || forms.find((item) => item.folderId === folderId && item.hasXml && item.primaryIdentifierVariable)?.primaryIdentifierVariable
          || ""
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
        addMissingPrimaryIdentifier: linkage.addMissingPrimaryIdentifier,
        folderId: pendingXlsxImport.folderId
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
    const linkedWorkspaceIds = forms
      .filter((item) => item.metaFormLink?.fileName === fileName)
      .map((item) => item.workspaceId);
    const confirmed = await requestConfirmation({
      title: "Delete MetaForm?",
      message: `Delete schema metadata document "${fileName}"? This removes the uploaded DOCX, processed Markdown/chunks, and ${linkedWorkspaceIds.length} linked form${linkedWorkspaceIds.length === 1 ? "" : "s"}, including their entries, XLSForms, XML, and FHIR bundles.`,
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
      if (data.deletedWorkspaceIds?.some((id) => workspaceRouteId(workspace?.workspaceId) === workspaceRouteId(id))) {
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
      setStatus({ kind: "ok", message: `Deleted MetaForm and ${data.deletedWorkspaceIds?.length || 0} linked form(s): ${fileName}` });
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

  async function toggleCollectionAccess(workspaceId, locked) {
    const id = workspaceRouteId(workspaceId);
    setStatus({ kind: "busy", message: locked ? "Locking public access..." : "Unlocking public access..." });
    try {
      await requestJson(`/api/forms/${encodeURIComponent(id)}/collection-access`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ collectionLocked: locked })
      });
      await refreshForms();
      setStatus({ kind: "ok", message: locked ? "Form hidden from respondents and field agents." : "Form available to respondents and field agents." });
    } catch (error) {
      handleRequestError(error);
    }
  }

  function backHome() {
    setView("home");
    setSelectedId(null);
    refreshForms().catch(() => {});
  }

  function fillForm(workspaceId, entryId = "") {
    const query = entryId ? `?entryId=${encodeURIComponent(entryId)}` : "";
    window.open(`/fill/${encodeURIComponent(workspaceRouteId(workspaceId))}${query}`, "_blank", "noopener,noreferrer");
  }

  async function downloadOdkXls(workspaceId) {
    const id = workspaceRouteId(workspaceId || workspace?.workspaceId);
    if (!id) {
      setStatus({ kind: "error", message: "Open a published form before downloading ODK XLS." });
      return;
    }
    setStatus({ kind: "busy", message: "Downloading ODK XLS..." });
    try {
      const response = await fetch(`${API_BASE}/api/forms/${encodeURIComponent(id)}/xlsx`, {
        headers: adminAuthHeaders()
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "ODK XLS download failed.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/);
      downloadBlob(blob, match?.[1] || safeDownloadName(`${form.formId || form.title || "odk_form"}.xlsx`, "odk_form.xlsx"));
      setStatus({ kind: "ok", message: "ODK XLS downloaded." });
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function deleteFormEntries(entryIds) {
    if (!workspace?.workspaceId) return;
    const ids = (Array.isArray(entryIds) ? entryIds : [entryIds]).filter(Boolean);
    if (!ids.length) return;
    const confirmed = window.confirm(`Delete ${ids.length} entr${ids.length === 1 ? "y" : "ies"}? This cannot be undone.`);
    if (!confirmed) return;
    setStatus({ kind: "busy", message: "Deleting entries..." });
    try {
      const data = await deleteJson(`/api/forms/${encodeURIComponent(workspaceRouteId(workspace.workspaceId))}/entries`, { entryIds: ids });
      setEntries(data.entries || []);
      await refreshForms();
      notifyCollectionChanged();
      setStatus({ kind: "ok", message: `Deleted ${data.deletedCount || ids.length} entr${ids.length === 1 ? "y" : "ies"}.` });
    } catch (error) {
      handleRequestError(error);
    }
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

  async function uploadOptionMedia(questionId, optionId, fieldName, event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    const id = workspaceRouteId(workspace?.workspaceId);
    if (!id || !file || !questionId || !optionId || !fieldName) {
      setStatus({ kind: "error", message: "Open a form workspace before uploading option media." });
      return;
    }
    setStatus({ kind: "busy", message: `Uploading ${file.name}...` });
    try {
      const dataBase64 = await fileToBase64(file);
      const data = await postJson(`/api/forms/${encodeURIComponent(id)}/attachments`, {
        filename: file.name,
        dataBase64
      });
      updateQuestion(questionId, {
        options: (form.questions.find((item) => item.id === questionId)?.options || []).map((option) => (
          option.id === optionId ? { ...option, [fieldName]: file.name } : option
        ))
      });
      setAttachments(data.attachments || []);
      setWorkspace((current) => ({ ...current, ...data }));
      await refreshForms();
      setStatus({ kind: "ok", message: `Uploaded ${file.name} and linked it to the choice.` });
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
          folders={folders}
          schemaDocuments={schemaDocuments}
          schemaSummary={schemaSummary}
          status={status}
          createWorkspace={(folderId = "") => folderId
            ? setFolderFormPrompt({ folderId, folderName: folders.find((folder) => folder.id === folderId)?.name || "this folder" })
            : setNewFormPromptOpen(true)}
          uploadXlsxToFolder={(folderId, event) => {
            setFolderFormPrompt(null);
            importXlsx(event, folderId);
          }}
          openNewFormModal={() => setNewFormPromptOpen(true)}
          createFolder={createFolder}
          deleteFolder={deleteFolder}
          importXlsx={importXlsx}
          uploadSchemaDocument={uploadSchemaDocument}
          processSchemaDocuments={processSchemaDocuments}
          deleteSchemaDocument={deleteSchemaDocument}
          openWorkspace={openWorkspace}
          fillForm={fillForm}
          deleteWorkspace={deleteWorkspace}
          toggleCollectionAccess={toggleCollectionAccess}
          onLogout={onLogout}
          pendingXlsxImport={pendingXlsxImport}
          confirmXlsxImport={confirmXlsxImport}
          cancelXlsxImport={() => setPendingXlsxImport(null)}
          newFormPromptOpen={newFormPromptOpen}
          confirmNewForm={createWorkspace}
          cancelNewForm={() => setNewFormPromptOpen(false)}
          folderFormPrompt={folderFormPrompt}
          cancelFolderForm={() => setFolderFormPrompt(null)}
          createEmptyFolderForm={(folderId) => {
            setFolderFormPrompt(null);
            createWorkspace({ folderId });
          }}
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
	          updateTerminologyLlm={updateTerminologyLlm}
	          replaceTerminologyMapping={replaceTerminologyMapping}
	          addTerminologyEntity={addTerminologyEntity}
	          reviewIssue={reviewIssue}
	          isCopiedVersionDraft={isCopiedVersionDraft}
	          copiedVersionHasChanges={copiedVersionHasChanges}
	          createNewVersion={createNewVersion}
	          leaveAllTerminologyUnmappedAndPublish={leaveAllTerminologyUnmappedAndPublish}
	          passToMapper={passToMapper}
          downloadOdkXls={downloadOdkXls}
          backHome={backHome}
          fillForm={fillForm}
          uploadWorkspaceAttachments={uploadWorkspaceAttachments}
          uploadWorkspaceResource={uploadWorkspaceResource}
          uploadQuestionMedia={uploadQuestionMedia}
          uploadOptionMedia={uploadOptionMedia}
          deleteWorkspaceAttachment={deleteWorkspaceAttachment}
          viewEntry={viewEntry}
          deleteEntries={deleteFormEntries}
          refreshEntries={refreshCurrentEntries}
          respondentCodeMode={respondentCodeMode}
          setRespondentCodeMode={setRespondentCodeMode}
          customRespondentCode={customRespondentCode}
          setCustomRespondentCode={setCustomRespondentCode}
          allowResponseEdits={allowResponseEdits}
          setAllowResponseEdits={(value) => updateResponseSettings({ allowResponseEdits: value })}
          limitOneResponsePerIdentifier={limitOneResponsePerIdentifier}
          setLimitOneResponsePerIdentifier={(value) => updateResponseSettings({ limitOneResponsePerIdentifier: value })}
          participantIdentifierVariable={participantIdentifierVariable}
          setParticipantIdentifierVariable={(value) => updateResponseSettings({ participantIdentifierVariable: value })}
          folderParticipantIdentifierVariable={currentFolder?.participantIdentifierVariable || ""}
          onParticipantIdentifierActivated={refreshFolders}
          onLogout={onLogout}
        />
      )}
      {publishIdentifierPrompt ? (
        <PublishIdentifierModal
          form={form}
          status={status}
          candidates={primaryIdentifierCandidates()}
          folderName={currentFolder?.name || "this folder"}
          requiresFolderAcknowledgement={needsFolderPrimaryAcknowledgement}
          onCancel={() => {
            setPublishIdentifierPrompt(false);
            setPublishConfirmationAccepted(false);
          }}
          onPublish={(primaryIdentifierVariable, primaryIdentifierAcknowledged) => {
            const publishConfirmed = publishConfirmationAccepted;
            setPublishIdentifierPrompt(false);
            setPublishConfirmationAccepted(false);
            exportXlsForm(primaryIdentifierVariable, { publishConfirmed, primaryIdentifierAcknowledged });
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
  folders,
  schemaDocuments,
  schemaSummary,
  status,
  createWorkspace,
  openNewFormModal,
  importXlsx,
  uploadSchemaDocument,
  processSchemaDocuments,
  deleteSchemaDocument,
  openWorkspace,
  fillForm,
  deleteWorkspace,
  deleteFolder,
  toggleCollectionAccess,
  onLogout,
  pendingXlsxImport,
  confirmXlsxImport,
  cancelXlsxImport,
	  newFormPromptOpen,
	  confirmNewForm,
		  cancelNewForm,
		  createFolder,
		  folderFormPrompt,
		  cancelFolderForm,
		  createEmptyFolderForm,
		  uploadXlsxToFolder
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
      const folderRows = new Map(
        [...root.querySelectorAll("[data-folder-id]")]
          .filter((node) => node.classList.contains("folder-row"))
          .map((node) => [node.dataset.folderId, node])
      );
      for (const xlsRow of root.querySelectorAll("[data-folder-form-id]")) {
        const folderRow = folderRows.get(xlsRow.dataset.folderFormId);
        if (!folderRow) continue;
        const source = folderRow.getBoundingClientRect();
        const target = xlsRow.getBoundingClientRect();
        const x1 = source.right - rootRect.left;
        const y1 = source.top + source.height / 2 - rootRect.top;
        const x2 = target.left - rootRect.left;
        const y2 = target.top + target.height / 2 - rootRect.top;
        if (x2 <= x1 + 24) continue;
        const bend = Math.max(28, (x2 - x1) / 2);
        next.push({ id: `${xlsRow.dataset.workspaceId}-folder`, path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` });
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
	  }, [forms, folders, schemaDocuments, selectedVersionByGroup]);

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
          <BrandLogos />
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
          <FoldersPanel folders={folders} forms={forms} createFolder={createFolder} deleteFolder={deleteFolder} createWorkspace={createWorkspace} openWorkspace={openWorkspace} />
          <SchemaDocumentsPanel
            documents={schemaDocuments}
            summary={schemaSummary}
            status={status}
            uploadSchemaDocument={uploadSchemaDocument}
            processSchemaDocuments={processSchemaDocuments}
            deleteSchemaDocument={deleteSchemaDocument}
            linkedFormsByMetaForm={linkedFormsByMetaForm}
            openWorkspace={openWorkspace}
            fillForm={fillForm}
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
              <button className="primary small" onClick={openNewFormModal}>
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
                  data-folder-form-id={item.folderId || undefined}
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
                      {item.participantIdentifierVariable && item.participantIdentifierVariable !== item.primaryIdentifierVariable ? (
                        <span>Participant ID: <strong>{item.participantIdentifierVariable}</strong></span>
                      ) : null}
                    </div>
                  ) : item.primaryIdentifierVariable ? (
                    <div className="form-identity-strip">
                      <span>{item.participantIdentifierVariable && item.participantIdentifierVariable !== item.primaryIdentifierVariable ? "Participant ID" : "Primary ID"}: <strong>{item.participantIdentifierVariable || item.primaryIdentifierVariable}</strong></span>
                      <span>Form code: <strong>{item.respondentAccessCode || "—"}</strong></span>
                    </div>
                  ) : (
                    <div className="form-linkage unlinked">
                      <AlertCircle size={15} />
                      <span>Not linked to a MetaForm</span>
                    </div>
                  )}
                  {item.respondentAccessCode && item.metaFormLink?.fileName ? (
                    <div className="respondent-code-row">
                      <span>{item.collectionLocked ? "Locked respondent form code" : "Respondent form code"}</span>
                      <strong>{item.respondentAccessCode}</strong>
                    </div>
                  ) : null}
                  {item.collectionLocked ? (
                    <div className="form-linkage unlinked">
                      <X size={15} />
                      <span>Hidden from respondents and field agents</span>
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
                    {item.hasXml ? (
                      <button className="secondary" onClick={() => toggleCollectionAccess(item.workspaceId, !item.collectionLocked)}>
                        {item.collectionLocked ? <Check size={16} /> : <X size={16} />} {item.collectionLocked ? "Unlock Access" : "Lock Access"}
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
      {folderFormPrompt ? (
        <FolderFormModal
          folderName={folderFormPrompt.folderName}
          onCancel={cancelFolderForm}
          onCreateEmpty={() => createEmptyFolderForm(folderFormPrompt.folderId)}
          onUpload={(event) => uploadXlsxToFolder(folderFormPrompt.folderId, event)}
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
          <span>Published forms use the ODK Web Forms renderer for repeats, groups, barcode, media, external choices, location, calculations, and audit fields.</span>
          <span>XLSForm import reads workbook sheets such as survey, choices, settings, and entities. Upload companion files from Builder before publishing.</span>
          <span>FHIR bundles use the XLSForm/form builder definition and submitted answers. MetaForms are kept for context and later grouping.</span>
          <span>If a form references external CSV/media/map files, open Builder and upload them there before publishing. FHIR creation uses the form and its submitted answers, not the linked MetaForm.</span>
        </span>
      ) : null}
    </span>
  );
}

function FolderFormModal({ folderName, onCancel, onCreateEmpty, onUpload }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="link-modal" role="dialog" aria-modal="true" aria-label={`Add form to ${folderName}`}>
        <div className="modal-head">
          <div>
            <h2>Add Form to {folderName}</h2>
            <p>Choose how you want to start this form.</p>
          </div>
          <button className="icon-button" type="button" onClick={onCancel} aria-label="Close add form dialog">
            <X size={15} />
          </button>
        </div>
        <div className="choice-buttons folder-form-choice-buttons">
          <button className="choice-button" type="button" onClick={onCreateEmpty}>
            <Plus size={16} /> Create empty form
          </button>
          <label className="choice-button file-action" tabIndex={0}>
            <Import size={16} /> Upload ODK XLS form
            <input type="file" accept=".xlsx" onChange={onUpload} />
          </label>
        </div>
        <p className="modal-subtle-note">The uploaded XLS form will be imported into this folder and opened in the builder for review.</p>
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function FoldersPanel({ folders = [], forms = [], createFolder, deleteFolder, createWorkspace, openWorkspace }) {
  const folderFormGroups = new Map();
  for (const form of forms.filter((item) => item.folderId)) {
    const groupKey = form.versionBaseId
      || form.formId
      || form.title
      || String(form.workspaceId || "").replace(/_v\d+$/i, "");
    const group = folderFormGroups.get(`${form.folderId}:${groupKey}`) || [];
    group.push(form);
    folderFormGroups.set(`${form.folderId}:${groupKey}`, group);
  }

  function visibleFolderForms(folderId) {
    return [...folderFormGroups.entries()]
      .filter(([key]) => key.startsWith(`${folderId}:`))
      .map(([, versions]) => {
        const ordered = versions.sort((a, b) => Number(a.versionNumber || 1) - Number(b.versionNumber || 1));
        const unlocked = ordered.filter((item) => !item.collectionLocked);
        return unlocked.at(-1) || ordered.at(-1);
      })
      .filter(Boolean);
  }

  return (
    <section className="folders-panel">
      <div className="home-column-head folders-heading">
        <div><h2>Folders</h2><p>Organise forms outside MetaForms.</p></div>
        <button className="icon-button" type="button" onClick={createFolder} aria-label="Create folder"><Plus size={18} /></button>
      </div>
      {!folders.length ? <p className="muted">No folders yet.</p> : (
        <div className="folder-list">
          {folders.map((folder) => {
            const folderForms = visibleFolderForms(folder.id);
            const folderPrimaryIdentifier = folder.primaryIdentifierVariable
              || folderForms.find((form) => form.hasXml && form.primaryIdentifierVariable)?.primaryIdentifierVariable
              || "";
            const folderParticipantIdentifier = folder.participantIdentifierVariable
              || folderForms.find((form) => form.participantIdentifierVariable && form.participantIdentifierVariable !== form.primaryIdentifierVariable)?.participantIdentifierVariable
              || "";
            return (
              <div className="folder-row" data-folder-id={folder.id} key={folder.id}>
                <div className="folder-row-head">
                  <FolderOpen size={16} />
                  <strong>{folder.name} {folderPrimaryIdentifier ? <span className="primary-identifier-inline">({folderPrimaryIdentifier})</span> : null}{folderParticipantIdentifier ? <span className="primary-identifier-inline"> (barcode: {folderParticipantIdentifier})</span> : null}</strong>
                  <button className="icon-button small" type="button" onClick={() => window.open(`/folder-visualization/${encodeURIComponent(folder.id)}`, "_blank", "noopener,noreferrer")} aria-label={`Visualize responses in ${folder.name}`} title="Visualize folder responses"><Network size={15} /></button>
                  <button className="icon-button small" type="button" onClick={() => createWorkspace(folder.id)} aria-label={`Create form in ${folder.name}`}><Plus size={15} /></button>
                  <button className="icon-button small danger-action" type="button" onClick={() => deleteFolder(folder.id, folder.name)} aria-label={`Delete ${folder.name}`}><Trash2 size={15} /></button>
                </div>
                {folderForms.length ? (
                  <div className="folder-form-list">
                    {folderForms.map((form) => (
                      <button className="folder-form-link" type="button" key={form.workspaceId} onClick={() => openWorkspace(form.workspaceId)}>
                        <FileText size={14} /> <span>{form.title} <small>v{form.versionNumber || 1}</small></span>
                      </button>
                    ))}
                  </div>
                ) : <small className="muted">No forms in this folder.</small>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SchemaDocumentsPanel({ documents, summary, status, uploadSchemaDocument, processSchemaDocuments, deleteSchemaDocument, linkedFormsByMetaForm, openWorkspace, fillForm }) {
  const needsProcessing = documents.some((document) => document.status !== "Processed");
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="schema-panel">
      <div className="home-column-head">
        <button className="schema-panel-title" type="button" onClick={() => setCollapsed((current) => !current)} aria-expanded={!collapsed}>
          <div>
          <h2>MetaForms</h2>
          <p>{documents.length} schema documents</p>
          </div>
          <ChevronDown className={collapsed ? "collapsed" : ""} size={18} aria-hidden="true" />
        </button>
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
      {!collapsed ? <div className="schema-panel-body">
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
              {(() => {
                const primaryIdentifier = document.primaryIdentifierVariable
                  || linkedFormsByMetaForm?.get(document.fileName)?.find((item) => item.hasXml && item.primaryIdentifierVariable)?.primaryIdentifierVariable
                  || "";
                return (
              <div className="schema-doc-head">
                <div className="schema-doc-main">
                  <FileText size={17} />
                  <div>
                    <h3>{document.fileName} {primaryIdentifier ? <span className="primary-identifier-inline">({primaryIdentifier})</span> : null}</h3>
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
                );
              })()}
              <div className="schema-metrics">
                <span>{document.formCount || 0} forms</span>
                <span>{document.variableCount || 0} variables</span>
                <span>{document.chunkCount || 0} chunks</span>
                <span>{linkedFormsByMetaForm?.get(document.fileName)?.length || 0} XLS links</span>
              </div>
              {document.primaryIdentifierVariable || linkedFormsByMetaForm?.get(document.fileName)?.find((item) => item.hasXml && item.primaryIdentifierVariable) ? (
                <p className="schema-primary-hint">
                  Primary Identifier Variable: <strong>{document.primaryIdentifierVariable || linkedFormsByMetaForm.get(document.fileName).find((item) => item.hasXml && item.primaryIdentifierVariable).primaryIdentifierVariable}</strong>
                </p>
              ) : null}
              {linkedFormsByMetaForm?.get(document.fileName)?.length ? (
                <div className="schema-linked-form-list">
                  {linkedFormsByMetaForm.get(document.fileName).map((item) => (
                    <div className="schema-linked-form" key={item.workspaceId}>
                      <button className="schema-linked-form-main" type="button" onClick={() => openWorkspace(item.workspaceId)}>
                        <FileText size={14} />
                        <span>
                          <strong>{item.title}</strong>
                          <small>{item.formId || item.workspaceId} · {item.primaryIdentifierVariable || "No primary identifier"}</small>
                        </span>
                      </button>
                      <StageBadge stage={item.pipelineStage} />
                      {item.hasXml ? (
                        <button className="icon-button small" type="button" onClick={() => fillForm(item.workspaceId)} aria-label={`Fill ${item.title}`}><ExternalLink size={14} /></button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
      <p className="mono schema-path">{summary?.processedDir || "processedMD path will appear here"}</p>
      </div> : null}
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
    ? forms.filter((item) => item.metaFormLink?.fileName === linkedMetaFormFileName && item.hasXml && item.primaryIdentifierVariable)
    : [];
  const existingPrimaryIdentifier = linkedForms[0]?.primaryIdentifierVariable || selectedMetaForm?.primaryIdentifierVariable || "";
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
  const [folderPrimaryAcknowledged, setFolderPrimaryAcknowledged] = useState(false);
  const selectedMetaForm = processedDocuments.find((document) => document.fileName === linkedMetaFormFileName) || null;
  const linkedForms = linkedMetaFormFileName
    ? forms.filter((item) => item.metaFormLink?.fileName === linkedMetaFormFileName && item.hasXml && item.primaryIdentifierVariable)
    : [];
  const existingPrimaryIdentifier = linkedForms[0]?.primaryIdentifierVariable || selectedMetaForm?.primaryIdentifierVariable || "";
  const folderPrimaryIdentifier = String(pending.folderPrimaryIdentifier || "").trim();
  const folderPrimaryLocked = Boolean(pending.folderId && folderPrimaryIdentifier);
  const primaryIdentifierLocked = Boolean((linkedMetaFormFileName && existingPrimaryIdentifier) || folderPrimaryLocked);
  const effectivePrimaryIdentifier = folderPrimaryLocked
    ? folderPrimaryIdentifier
    : primaryIdentifierLocked
      ? existingPrimaryIdentifier
      : primaryIdentifierVariable;
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
  const needsFolderAcknowledgement = Boolean(pending.folderId && !folderPrimaryIdentifier && !linkedMetaFormFileName);
  const canImport = Boolean(
    effectivePrimaryIdentifier &&
    status.kind !== "busy" &&
    (!needsMetaFormDetails || (metaFormFormIndex && primaryIdentifierAcknowledged)) &&
    (!needsFolderAcknowledgement || folderPrimaryAcknowledged) &&
    (!primaryIdentifierMissing || primaryIdentifierLocked)
  );

  useEffect(() => {
    if (!linkedMetaFormFileName) {
      setPrimaryIdentifierAcknowledged(false);
      setFolderPrimaryAcknowledged(false);
      setMetaFormFormIndex("");
      return;
    }
    if (primaryIdentifierLocked) setPrimaryIdentifierVariable(existingPrimaryIdentifier);
    setPrimaryIdentifierAcknowledged(false);
    setFolderPrimaryAcknowledged(false);
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

        {needsFolderAcknowledgement ? (
          <label className="acknowledgement-box">
            <input
              type="checkbox"
              checked={folderPrimaryAcknowledged}
              onChange={(event) => setFolderPrimaryAcknowledged(event.target.checked)}
            />
            <span>
              I acknowledge that <strong>{effectivePrimaryIdentifier || "the selected variable"}</strong> is the common Primary Identifier Variable for every form created in <strong>{pending.folderName || "this folder"}</strong>.
            </span>
          </label>
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
              addMissingPrimaryIdentifier: primaryIdentifierMissing || folderPrimaryLocked,
            })}
          >
            <Import size={16} /> {primaryIdentifierMissing ? "Add the Primary Identifier Variable from the MetaForm and Import XLS" : "Import XLS"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PublishIdentifierModal({
  form,
  candidates,
  status,
  folderName = "this folder",
  requiresFolderAcknowledgement = false,
  onCancel,
  onPublish
}) {
  const initialPrimaryIdentifier = candidates.some((candidate) => candidate.name === form.primaryIdentifierVariable)
    ? form.primaryIdentifierVariable
    : candidates[0]?.name || "";
  const [primaryIdentifierVariable, setPrimaryIdentifierVariable] = useState(initialPrimaryIdentifier);
  const [folderAcknowledged, setFolderAcknowledged] = useState(false);
  const canPublish = candidates.some((candidate) => candidate.name === primaryIdentifierVariable)
    && status.kind !== "busy"
    && (!requiresFolderAcknowledgement || folderAcknowledged);

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
          <select
            value={primaryIdentifierVariable}
            onChange={(event) => {
              setPrimaryIdentifierVariable(event.target.value);
              setFolderAcknowledged(false);
            }}
          >
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
                onClick={() => {
                  setPrimaryIdentifierVariable(variable.name);
                  setFolderAcknowledged(false);
                }}
              >
                <span className="mono">{variable.name}</span>
                <span>{variable.label || variable.type || "No label"}</span>
              </button>
            ))}
          </div>
        </div>

        {requiresFolderAcknowledgement ? (
          <label className="acknowledgement-box">
            <input
              type="checkbox"
              checked={folderAcknowledged}
              onChange={(event) => setFolderAcknowledged(event.target.checked)}
            />
            <span>
              I acknowledge that <strong>{primaryIdentifierVariable || "the selected variable"}</strong> is the common Primary Identifier Variable for every form created in <strong>{folderName}</strong>.
            </span>
          </label>
        ) : null}

        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!canPublish} onClick={() => onPublish(primaryIdentifierVariable, folderAcknowledged)}>
            <Forward size={16} /> Publish
          </button>
        </div>
      </div>
    </div>
  );
}

function PublishSettings({
  published,
  status,
  respondentAccessCode,
  primaryIdentifierVariable,
  participantIdentifierVariable,
  participantIdentifierCandidates = [],
  setParticipantIdentifierVariable,
  respondentCodeMode,
  setRespondentCodeMode,
  customRespondentCode,
  setCustomRespondentCode,
  allowResponseEdits,
  setAllowResponseEdits,
  limitOneResponsePerIdentifier,
  setLimitOneResponsePerIdentifier
}) {
  const fixedCode = normalizeAccessCodeInput(respondentAccessCode);
  const customCode = normalizeAccessCodeInput(customRespondentCode);
  const identifierLabel = participantIdentifierVariable || primaryIdentifierVariable || "participant identifier variable";
  const participantOptions = [
    ...(primaryIdentifierVariable ? [{ name: primaryIdentifierVariable, label: "Form primary identifier" }] : []),
    ...participantIdentifierCandidates.filter((candidate) => candidate.name !== primaryIdentifierVariable)
  ];

  return (
    <div className="publish-settings">
      <section className="publish-setting-block">
        <div className="publish-setting-heading">
          <h3>Participant identifier</h3>
          <p>After publishing, an admin can use a barcode as the identifier for new submissions, duplicate checks, checkpoints, and entry display.</p>
        </div>
        <label className="field">
          <span>Identifier collected from respondent</span>
          <select
            value={participantIdentifierVariable || primaryIdentifierVariable}
            disabled={!published || !participantOptions.length || status?.kind === "busy"}
            onChange={(event) => setParticipantIdentifierVariable(event.target.value)}
          >
            {participantOptions.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name}{candidate.label ? ` · ${candidate.label}` : ""}
              </option>
            ))}
          </select>
        </label>
        {published && participantIdentifierCandidates.length ? (
          <small className="publish-muted-note">Choose the barcode question when this form should collect only the assigned participant barcode.</small>
        ) : null}
      </section>

      <section className="publish-setting-block">
        <div className="publish-setting-heading">
          <h3>Code setting</h3>
          <p>{published ? "The respondent form code is fixed for this published form." : "Choose how respondents will open this form after publish."}</p>
        </div>
        <div className="publish-code-tabs">
          <button
            className={`access-role-button ${respondentCodeMode === RESPONDENT_CODE_MODE_RANDOM ? "active" : ""}`}
            disabled={published}
            type="button"
            onClick={() => setRespondentCodeMode(RESPONDENT_CODE_MODE_RANDOM)}
          >
            <span>Generate random code</span>
            <RefreshCw size={18} />
          </button>
          <button
            className={`access-role-button ${respondentCodeMode === RESPONDENT_CODE_MODE_CUSTOM ? "active" : ""}`}
            disabled={published}
            type="button"
            onClick={() => setRespondentCodeMode(RESPONDENT_CODE_MODE_CUSTOM)}
          >
            <span>Create a custom code</span>
            <TextCursorInput size={18} />
          </button>
        </div>
        {published && fixedCode ? (
          <div className="respondent-code-callout">
            <span>Respondent form code</span>
            <strong>{fixedCode}</strong>
            <p>Share this code with respondents. They can enter it from the respondent page without an admin password.</p>
          </div>
        ) : respondentCodeMode === RESPONDENT_CODE_MODE_CUSTOM ? (
          <label className="publish-custom-code-field">
            <span>Custom respondent form code</span>
            <input
              className="access-code-input"
              value={customCode}
              maxLength={RESPONDENT_CODE_MAX_LENGTH}
              placeholder="A1B2C"
              onChange={(event) => setCustomRespondentCode(normalizeAccessCodeInput(event.target.value))}
            />
            <small>Use up to 10 letters or numbers. It will be locked once the form is published.</small>
          </label>
        ) : (
          <p className="publish-muted-note">A unique code will be generated when publishing succeeds.</p>
        )}
      </section>

      <section className="publish-setting-block">
        <div className="publish-setting-heading">
          <h3>Response settings</h3>
          <p>These controls are enforced for new submissions and can be changed after publishing.</p>
        </div>
        <div className="publish-toggle-list">
          <div className="publish-future-toggle">
            <Toggle label="Responses can be changed after being submitted" checked={allowResponseEdits} onChange={setAllowResponseEdits} />
            <small>When enabled, entries show an edit action and submitted records can be updated.</small>
          </div>
          <div className="publish-future-toggle">
            <Toggle
              label={`One ${identifierLabel} can submit only one response`}
              checked={limitOneResponsePerIdentifier}
              onChange={setLimitOneResponsePerIdentifier}
            />
            <small>When enabled, duplicate submissions with the same identifier are rejected.</small>
          </div>
        </div>
      </section>
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
	    updateTerminologyLlm,
	    replaceTerminologyMapping,
	    addTerminologyEntity,
	    reviewIssue,
	    isCopiedVersionDraft,
	    copiedVersionHasChanges,
	    createNewVersion,
	    leaveAllTerminologyUnmappedAndPublish,
	    passToMapper,
    downloadOdkXls,
    backHome,
    fillForm,
    uploadWorkspaceAttachments,
    uploadWorkspaceResource,
    uploadQuestionMedia,
    uploadOptionMedia,
    deleteWorkspaceAttachment,
    viewEntry,
    deleteEntries,
    refreshEntries,
    respondentCodeMode,
    setRespondentCodeMode,
    customRespondentCode,
    setCustomRespondentCode,
    allowResponseEdits,
    setAllowResponseEdits,
    limitOneResponsePerIdentifier,
    setLimitOneResponsePerIdentifier,
    participantIdentifierVariable,
    setParticipantIdentifierVariable,
    folderParticipantIdentifierVariable,
    onParticipantIdentifierActivated,
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
  const participantIdentifierCandidates = useMemo(
    () => primaryIdentifierCandidatesForForm(form).filter((candidate) => candidate.type === "barcode"),
    [form]
  );
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
          <BrandLogos />
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
          <section className="publish-stack">
            <div className="panel publish-summary">
              <div className="section-head">
                <div>
                  <StageBadge stage={currentStage} />
                  <h2>Terminology</h2>
                  <p>Review vocabulary mappings for the form definition.</p>
                </div>
                <button className="secondary" disabled={!workspace?.workspaceId || status.kind === "busy"} onClick={() => downloadOdkXls?.(workspace.workspaceId)}>
                  <Download size={16} /> Export ODK XLS
                </button>
              </div>
            </div>
          <TerminologyPanel
            form={form}
            workspace={workspace}
            terminology={terminology}
	            status={status}
	            runTerminologyExtraction={runTerminologyExtraction}
	            updateTerminologyLlm={updateTerminologyLlm}
	            replaceTerminologyMapping={replaceTerminologyMapping}
	            addTerminologyEntity={addTerminologyEntity}
	            reviewIssue={reviewIssue}
            locked={published}
	          />
          </section>
        </main>
      ) : activeStage === "publish" ? (
        <main className="publish-layout">
          <section className="publish-stack">
            <div className="panel publish-summary">
              <h2>Publish</h2>
              <p>{published ? "This form is published locally. Fill it in the browser, inspect submitted entries, then generate FHIR bundles." : "Publish the form after vocabulary review is complete."}</p>
              <PublishSettings
                published={published}
                status={status}
                respondentAccessCode={workspace?.respondentAccessCode}
                primaryIdentifierVariable={form.primaryIdentifierVariable}
                participantIdentifierVariable={participantIdentifierVariable}
                participantIdentifierCandidates={participantIdentifierCandidates}
                setParticipantIdentifierVariable={(value) => updateResponseSettings({ participantIdentifierVariable: value })}
                respondentCodeMode={respondentCodeMode}
                setRespondentCodeMode={setRespondentCodeMode}
                customRespondentCode={customRespondentCode}
                setCustomRespondentCode={setCustomRespondentCode}
                allowResponseEdits={allowResponseEdits}
                setAllowResponseEdits={setAllowResponseEdits}
                limitOneResponsePerIdentifier={limitOneResponsePerIdentifier}
                setLimitOneResponsePerIdentifier={setLimitOneResponsePerIdentifier}
              />
              {!published ? (
                <div className="stage-actions">
                  <button className="primary" disabled={status.kind === "busy"} onClick={() => exportXlsForm()}>
                    <Forward size={16} /> Publish
                  </button>
                </div>
              ) : null}
            </div>
            {published ? <ParticipantAssignmentPanel form={form} workspaceId={workspace?.workspaceId} folderParticipantIdentifierVariable={folderParticipantIdentifierVariable} onActivated={onParticipantIdentifierActivated} /> : null}
            <EntriesPanel
              form={form}
              entries={entries}
              workspaceId={workspace?.workspaceId}
              viewEntry={viewEntry}
              editEntry={(entryId) => fillForm(workspace.workspaceId, entryId)}
              deleteEntries={deleteEntries}
              refreshEntries={refreshEntries}
              status={status}
              allowResponseEdits={allowResponseEdits}
            />
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
              <button className="primary" type="button" onClick={() => addQuestion(questionTypeToAdd)}>
                <Plus size={16} /> Add Question
              </button>
            </div>

            <div className="side-form-meta">
              <div className="side-settings-block">
                <Toggle
                  label="Multilingual text"
                  checked={form.multilingualEnabled}
                  disabled={locked}
                  onChange={(value) => updateForm({ multilingualEnabled: value })}
                />
                {form.multilingualEnabled ? (
                  <Field
                    label="Second language name"
                    value={form.multilingualLanguage}
                    disabled={locked}
                    placeholder="Hindi"
                    onChange={(value) => updateForm({ multilingualLanguage: value })}
                  />
                ) : null}
              </div>
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
                uploadOptionMedia={uploadOptionMedia}
                readOnly={locked || Boolean(selectedQuestion.identifierLocked)}
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
	              onClick={() => goToPublish?.()}
	            >
	              <Forward size={16} /> {published ? "Publish -->" : "Publish"}
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

function EntriesPanel({ form, entries, workspaceId, viewEntry, editEntry, deleteEntries, refreshEntries, status, allowResponseEdits = false }) {
  const entryIds = useMemo(() => entries.map((entry) => String(entry.id || "")).filter(Boolean), [entries]);
  const entryIdKey = entryIds.join("|");
  const [selectedEntryIds, setSelectedEntryIds] = useState([]);
  const selectedEntrySet = useMemo(() => new Set(selectedEntryIds), [selectedEntryIds]);
  const selectedEntries = entries.filter((entry) => selectedEntrySet.has(String(entry.id || "")));
  const allSelected = entryIds.length > 0 && selectedEntryIds.length === entryIds.length;
  const csvHeaders = useMemo(() => entryCsvQuestions(form).map((question) => question.name), [form]);
  const displayOptions = useMemo(() => entryDisplayOptions(form), [form]);
  const defaultDisplayField = form?.participantIdentifierVariable || form?.primaryIdentifierVariable || displayOptions[0]?.name || "";
  const [displayField, setDisplayField] = useState(defaultDisplayField);

  useEffect(() => {
    setDisplayField((current) => displayOptions.some((item) => item.name === current)
      ? current
      : defaultDisplayField);
  }, [defaultDisplayField, displayOptions]);

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
              <button className="primary small" disabled={!selectedEntries.length || !csvHeaders.length} onClick={downloadSelectedEntries}>
                <Download size={14} /> Download CSV
              </button>
              <label className="display-field-select">
                <span>Display</span>
                <select value={displayField} onChange={(event) => setDisplayField(event.target.value)}>
                  {displayOptions.map((option) => (
                    <option key={option.name} value={option.name}>{option.label}</option>
                  ))}
                </select>
              </label>
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
            <button className="secondary small danger-action" disabled={!selectedEntryIds.length || status?.kind === "busy"} onClick={() => deleteEntries?.(selectedEntryIds)}>
              <Trash2 size={14} /> Delete
            </button>
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
                <span>{entryDisplayValue(entry, displayField)}</span>
                <small>
                  {new Date(entry.submittedAt).toLocaleString()}
                  {entry.instanceName && entry.instanceName !== entry.id ? ` · ${entry.id}` : ""}
                </small>
              </div>
              <div className="entry-actions">
                {allowResponseEdits ? (
                  <button className="secondary small" disabled={!workspaceId} onClick={() => editEntry?.(entry.id)} title="Edit entry">
                    <TextCursorInput size={14} /> Edit
                  </button>
                ) : null}
                <button className="secondary small" disabled={!workspaceId} onClick={() => viewEntry(workspaceId, entry.id)}>
                  <ExternalLink size={14} /> View
                </button>
                <button className="secondary small danger-action" disabled={!workspaceId || status?.kind === "busy"} onClick={() => deleteEntries?.([entry.id])}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </div>
          );})}
        </div>
      )}
    </div>
  );
}

function TerminologyPanel({ form, workspace, terminology = {}, status, runTerminologyExtraction, updateTerminologyLlm, replaceTerminologyMapping, addTerminologyEntity, reviewIssue, locked = false }) {
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
	        <div className="terminology-llm-control">
          <div>
            <strong>LLM-assisted extraction</strong>
            <p>LLM-assisted extraction - temporarily down</p>
          </div>
          <Toggle
            label="Use LLM-assisted extraction"
            hideLabel
            checked={false}
            disabled
            onChange={() => updateTerminologyLlm?.(false)}
          />
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
              <div className="question-label">{question.label || questionTypeLabel(question.type)}</div>
              <div className="question-meta">
                <span>{question.type}</span>
                {question.name ? <span>{question.name}</span> : null}
                {question.required ? <span>required</span> : null}
                {!question.required && question.requiredExpression ? <span>conditional required</span> : null}
                {question.readOnly || question.type === "calculate" ? <span className="state-chip readonly">read only</span> : null}
                {!question.readOnly && question.type !== "calculate" && question.readOnlyExpression ? <span className="state-chip readonly">conditional read only</span> : null}
                {question.calculation ? <span className="state-chip calculation">calculation</span> : null}
                {question.type === "timer" ? <span className="state-chip timer">{normalizeTimerConfig(question.timerConfig).mode.replace(/_/g, " ")}</span> : null}
                {resources?.missing ? <span className="resource-chip missing">{resources.missing} files needed</span> : resources?.total ? <span className="resource-chip uploaded">files ready</span> : null}
              </div>
            </div>
            <button
              className="icon-button"
              disabled={locked || question.demographicGeneratedId}
              title={question.demographicGeneratedId ? "The generated demographic ID cannot be duplicated" : "Duplicate question"}
              onClick={(event) => { event.stopPropagation(); duplicateQuestion(question); }}
            >
              <Copy size={16} />
            </button>
            <button
              className="icon-button danger"
              disabled={locked || isDemographicGeneratedIdLocked(form.questions, question.id)}
              title={isDemographicGeneratedIdLocked(form.questions, question.id) ? "Turn off Demographic data to remove the generated ID" : "Delete question"}
              onClick={(event) => { event.stopPropagation(); removeQuestion(question.id); }}
            >
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

function parseLocationPoints(value) {
  return String(value || "")
    .split(";")
    .map((point) => point.trim().split(/\s+/).map(Number))
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map(([lat, lon, alt = 0, accuracy = 0]) => ({ lat, lon, alt, accuracy }));
}

function formatLocationPoint(point) {
  return [point.lat, point.lon, point.alt ?? 0, point.accuracy ?? 0].join(" ");
}

function LocationCaptureField({ question, value, onChange, disabled, label, hintNode }) {
  const points = parseLocationPoints(value);
  const isPoint = question.type === "geopoint";
  const isShape = question.type === "geoshape";
  const canDraw = !disabled;
  const toSvgPoint = (point) => `${((point.lon + 180) / 360) * 100},${((90 - point.lat) / 180) * 100}`;

  function addPointFromEvent(event) {
    if (!canDraw) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const lon = ((event.clientX - bounds.left) / bounds.width) * 360 - 180;
    const lat = 90 - ((event.clientY - bounds.top) / bounds.height) * 180;
    const nextPoint = { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), alt: 0, accuracy: 0 };
    const next = isPoint ? [nextPoint] : [...points, nextPoint];
    onChange(next.map(formatLocationPoint).join("; "));
  }

  function captureCurrentLocation() {
    if (!canDraw || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((position) => {
      const coords = position.coords;
      const nextPoint = {
        lat: Number(coords.latitude.toFixed(6)),
        lon: Number(coords.longitude.toFixed(6)),
        alt: Number.isFinite(coords.altitude) ? Number(coords.altitude.toFixed(2)) : 0,
        accuracy: Number.isFinite(coords.accuracy) ? Number(coords.accuracy.toFixed(2)) : 0
      };
      const next = isPoint ? [nextPoint] : [...points, nextPoint];
      onChange(next.map(formatLocationPoint).join("; "));
    }, () => {});
  }

  const path = points.map(toSvgPoint).join(" ");
  return (
    <div className="preview-field location-preview-field">
      <span>{label}</span>
      {hintNode}
      <div className={`location-capture location-capture-${question.type}`}>
        <svg className="location-sketch" viewBox="0 0 100 100" role="img" aria-label="Interactive location drawing area" onClick={addPointFromEvent}>
          <defs>
            <pattern id={`location-grid-${question.id}`} width="10" height="10" patternUnits="userSpaceOnUse">
              <path d="M 10 0 L 0 0 0 10" fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="0.35" />
            </pattern>
          </defs>
          <rect width="100" height="100" fill="url(#location-grid-${question.id})" />
          {isShape && points.length > 2 ? <polygon points={path} className="location-shape" /> : null}
          {!isPoint && points.length > 1 ? <polyline points={path} className="location-line" /> : null}
          {points.map((point, index) => {
            const [x, y] = toSvgPoint(point).split(",");
            return <circle key={`${x}-${y}-${index}`} cx={x} cy={y} r="1.8" className="location-point" />;
          })}
          {!points.length ? <text x="50" y="48" textAnchor="middle" className="location-empty-label">Click to place a point</text> : null}
        </svg>
        <div className="location-capture-actions">
          <button type="button" className="secondary small" disabled={!canDraw || !navigator.geolocation} onClick={captureCurrentLocation}><MapPin size={14} /> Use current location</button>
          {!isPoint && points.length ? <button type="button" className="secondary small" disabled={!canDraw} onClick={() => onChange(points.slice(0, -1).map(formatLocationPoint).join(";"))}>Undo point</button> : null}
          {points.length ? <button type="button" className="secondary small" disabled={!canDraw} onClick={() => onChange("")}>Clear</button> : null}
        </div>
      </div>
      <div className="location-coordinates">
        {points.length ? points.map((point, index) => <code key={`${point.lat}-${point.lon}-${index}`}>{index + 1}. {point.lat}, {point.lon}</code>) : <small>{isPoint ? "Place one GPS point." : isShape ? "Add at least three points to outline an area." : "Add two or more points to draw a route."}</small>}
      </div>
    </div>
  );
}

function BarcodeCaptureField({ value = "", onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState({ kind: "idle", message: "" });
  const videoRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!open || disabled) return undefined;
    let stopped = false;
    let captured = false;
    let stream = null;
    let scanTimer = null;
    let nativeTimer = null;
    const oneDimensionalFormats = [
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.EAN_8,
      BarcodeFormat.EAN_13,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.CODE_93,
      BarcodeFormat.ITF,
      BarcodeFormat.CODABAR,
      BarcodeFormat.RSS_14,
      BarcodeFormat.RSS_EXPANDED
    ];
    const oneDimensionalReader = new BrowserMultiFormatOneDReader(new Map([
      [DecodeHintType.POSSIBLE_FORMATS, oneDimensionalFormats]
    ]));
    const qrReader = new BrowserQRCodeReader();
    let frameCanvas = null;
    let frameContext = null;
    let scanStartedAt = 0;
    let showedSlowScanHint = false;
    let nativeDetector = null;
    try {
      if (window.BarcodeDetector) nativeDetector = new window.BarcodeDetector();
    } catch {
      // ZXing still handles scanning when the native detector cannot initialize.
    }
    const stop = () => {
      stopped = true;
      window.clearTimeout(scanTimer);
      window.clearTimeout(nativeTimer);
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
    const capture = (text) => {
      if (stopped || captured || !text) return;
      captured = true;
      onChangeRef.current(text);
      setStatus({ kind: "ok", message: "Barcode captured." });
      setOpen(false);
    };

    const isExpectedDecodeMiss = (error) => {
      const name = String(error?.name || error?.constructor?.name || "");
      return name.startsWith("NotFoundException") || name.startsWith("ChecksumException") || name.startsWith("FormatException");
    };

    const scanWithZxing = () => {
      if (stopped || captured) return;
      const video = videoRef.current;
      if (video?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        if (!frameCanvas) {
          frameCanvas = document.createElement("canvas");
          frameContext = frameCanvas.getContext("2d", { willReadFrequently: true });
        }
        if (!frameContext) {
          setStatus({ kind: "error", message: "This browser cannot prepare camera frames for scanning. Use Scan photo or enter the barcode manually." });
          return;
        }
        frameCanvas.width = video.videoWidth;
        frameCanvas.height = video.videoHeight;
        frameContext.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
        const readers = [oneDimensionalReader, qrReader];
        for (const reader of readers) {
          try {
            capture(reader.decodeFromCanvas(frameCanvas).getText());
            break;
          } catch (error) {
            if (!isExpectedDecodeMiss(error)) {
              setStatus({ kind: "error", message: `Scanner could not read this camera frame. Use Scan photo or enter the barcode manually.` });
            }
          }
        }
      }
      if (!captured && !showedSlowScanHint && performance.now() - scanStartedAt > 10000) {
        showedSlowScanHint = true;
        setStatus({ kind: "idle", message: "No valid barcode detected. Keep the whole code and white margins visible. EAN/UPC samples also need a valid final check digit." });
      }
      if (!captured && !stopped) scanTimer = window.setTimeout(scanWithZxing, 180);
    };

    const scanWithNativeDetector = async () => {
      if (stopped || captured || !nativeDetector) return;
      const video = videoRef.current;
      if (video?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        try {
          const matches = await nativeDetector.detect(video);
          capture(matches.find((match) => match.rawValue)?.rawValue);
        } catch {
          // ZXing continues decoding even if the browser detector rejects a frame.
        }
      }
      if (!captured && !stopped) nativeTimer = window.setTimeout(scanWithNativeDetector, 300);
    };

    async function startScanner() {
      if (!window.isSecureContext && window.location.hostname !== "localhost") {
        setStatus({ kind: "error", message: "Camera scanning requires HTTPS or localhost." });
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus({ kind: "error", message: "This browser does not provide camera access." });
        return;
      }
      try {
        const video = videoRef.current;
        if (!video) return;
        const camera = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        if (stopped) {
          camera.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = camera;
        video.srcObject = camera;
        await video.play();
        if (stopped) return;
        setStatus({ kind: "ok", message: "Hold the barcode steady inside the camera view." });
        scanStartedAt = performance.now();
        scanWithZxing();
        scanWithNativeDetector();
      } catch (error) {
        if (!stopped) {
          setStatus({ kind: "error", message: error?.name === "NotAllowedError" ? "Camera permission was denied. Allow access or enter the code manually." : `Could not start the camera: ${error?.message || String(error)}` });
          stop();
        }
      }
    }

    startScanner();
    return () => {
      stop();
    };
  }, [open, disabled]);

  async function scanImage(file) {
    if (!file) return;
    setStatus({ kind: "busy", message: "Reading barcode image..." });
    const url = URL.createObjectURL(file);
    try {
      const reader = new BrowserMultiFormatReader(new Map([[DecodeHintType.TRY_HARDER, true]]));
      const result = await reader.decodeFromImageUrl(url);
      onChangeRef.current(result.getText());
      setOpen(false);
      setStatus({ kind: "ok", message: "Barcode captured." });
    } catch (error) {
      setStatus({ kind: "error", message: `No readable barcode found in this image. ${error?.name === "NotFoundException" ? "Try a sharper, closer photo." : error?.message || ""}` });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return (
    <div className="barcode-capture">
      <div className="barcode-input-row">
        <input type="text" value={value} disabled={disabled} placeholder="Scan or enter barcode" onChange={(event) => onChange(event.target.value)} />
        <button className="secondary small" type="button" disabled={disabled} onClick={() => { setStatus({ kind: "idle", message: "Opening camera..." }); setOpen(true); }}>
          <ScanLine size={14} /> Scan
        </button>
      </div>
      {open ? (
        <div className="barcode-scanner" role="dialog" aria-label="Scan barcode">
          <video ref={videoRef} className="barcode-video" muted playsInline />
          <div className={`barcode-scanner-status ${status.kind}`}>{status.message || "Starting camera..."}</div>
          <label className="secondary small barcode-photo-button">
            <Image size={14} /> Scan photo
            <input type="file" accept="image/*" onChange={(event) => { scanImage(event.target.files?.[0]); event.target.value = ""; }} />
          </label>
          <button className="secondary small" type="button" onClick={() => setOpen(false)}>Close scanner</button>
        </div>
      ) : null}
      {!open && status.message ? <small className={`barcode-status ${status.kind}`}>{status.message}</small> : null}
    </div>
  );
}

function ParticipantAssignmentPanel({ form, workspaceId, folderParticipantIdentifierVariable = "", onActivated }) {
  const [rows, setRows] = useState([]);
  const [displayOptions, setDisplayOptions] = useState([]);
  const [displayField, setDisplayField] = useState("");
  const [barcodeDrafts, setBarcodeDrafts] = useState({});
  const [barcodeVariable, setBarcodeVariable] = useState(folderParticipantIdentifierVariable || "participant_barcode");
  const [identifierActivated, setIdentifierActivated] = useState(Boolean(folderParticipantIdentifierVariable));
  const [collapsed, setCollapsed] = useState(false);
  const [status, setStatus] = useState({ kind: "busy", message: "Loading demographic participants..." });
  const hasDemographicRepeat = Boolean(form?.questions?.some((question) => question.type === "begin_repeat" && question.demographicData));

  useEffect(() => {
    setBarcodeVariable(folderParticipantIdentifierVariable || "participant_barcode");
    setIdentifierActivated(Boolean(folderParticipantIdentifierVariable));
  }, [folderParticipantIdentifierVariable]);

  async function refreshParticipants(showStatus = true) {
    if (!workspaceId || !hasDemographicRepeat) return;
    if (showStatus) setStatus({ kind: "busy", message: "Refreshing participant assignments..." });
    try {
      const data = await requestJson(`/api/forms/${encodeURIComponent(workspaceRouteId(workspaceId))}/participants`);
      const nextRows = data.rows || [];
      const nextOptions = data.options || [];
      setRows(nextRows);
      setDisplayOptions(nextOptions);
      setDisplayField((current) => current && nextOptions.some((option) => option.name === current)
        ? current
        : nextOptions[0]?.name || "");
      setBarcodeDrafts(Object.fromEntries(nextRows.map((row) => [row.id, row.barcode || ""])));
      setStatus({
        kind: "ok",
        message: showStatus
          ? (nextRows.length ? "Participant assignments refreshed." : "No demographic repeat entries found.")
          : (nextRows.length ? "Ready to assign participant barcodes." : "No demographic repeat entries found.")
      });
    } catch (error) {
      setStatus({ kind: "error", message: error.message || String(error) });
    }
  }

  useEffect(() => {
    if (!workspaceId || !hasDemographicRepeat) return undefined;
    let cancelled = false;
    refreshParticipants(false).catch(() => {});
    return () => { cancelled = true; };
  }, [hasDemographicRepeat, workspaceId]);

  if (!hasDemographicRepeat) return null;

  async function assign(row) {
    const barcode = String(barcodeDrafts[row.id] || "").trim();
    if (!barcode) {
      setStatus({ kind: "error", message: "Scan or enter a barcode before assigning it." });
      return;
    }
    setStatus({ kind: "busy", message: "Saving participant barcode..." });
    try {
      const data = await postJson(`/api/forms/${encodeURIComponent(workspaceRouteId(workspaceId))}/participants/assign`, {
        entryId: row.entryId,
        repeatName: row.repeatName,
        repeatIndex: row.repeatIndex,
        barcode,
        participantIdentifierVariable: barcodeVariable
      });
      setRows(data.rows || []);
      setStatus({ kind: "ok", message: `Barcode assigned to ${row.memberIdentifier || `member ${row.repeatIndex}`}.` });
    } catch (error) {
      setStatus({ kind: "error", message: error.message || String(error) });
    }
  }

  async function activateParticipantIdentifier() {
    const assignedCount = rows.filter((row) => row.barcode).length;
    if (!assignedCount || identifierActivated) return;
    setStatus({ kind: "busy", message: "Updating folder participant identifier..." });
    try {
      const data = await postJson(`/api/forms/${encodeURIComponent(workspaceRouteId(workspaceId))}/participants/activate`, {
        participantIdentifierVariable: barcodeVariable
      });
      setIdentifierActivated(true);
      setBarcodeVariable(data.participantIdentifierVariable || barcodeVariable);
      await onActivated?.();
      setStatus({ kind: "ok", message: `Participant identifier changed to ${data.participantIdentifierVariable || barcodeVariable}.` });
    } catch (error) {
      setStatus({ kind: "error", message: error.message || String(error) });
    }
  }

  function rowDisplayValue(row) {
    const value = row.displayAnswers?.[displayField];
    if (Array.isArray(value)) return value.filter(Boolean).join(", ") || "Not answered";
    return String(value ?? "").trim() || row.memberIdentifier || `Member ${row.repeatIndex}`;
  }

  return (
    <section className="panel participant-assignment-panel">
      <div className="section-head participant-assignment-head">
        <div>
          <h2>Assign Participant Barcodes</h2>
          <p>Assign a scanned barcode to each selected demographic member. Household and generated member IDs remain unchanged.</p>
        </div>
        <div className="section-actions participant-assignment-actions">
          <span>{rows.filter((row) => row.barcode).length}/{rows.length} assigned</span>
          <button className="secondary small" type="button" onClick={() => setCollapsed((current) => !current)}>
            {collapsed ? "Show" : "Hide"}
          </button>
          <button className="secondary small" type="button" disabled={status.kind === "busy"} onClick={() => refreshParticipants()}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>
      {!collapsed ? <>
      <div className="participant-assignment-note">
        Only assigned barcodes can be used as participant identifiers in later forms. A barcode can belong to only one participant across this project.
      </div>
      {displayOptions.length ? (
        <label className="display-field-select participant-display-field">
          <span>Display</span>
          <select value={displayField} onChange={(event) => setDisplayField(event.target.value)}>
            {displayOptions.map((option) => <option key={option.name} value={option.name}>{option.label}</option>)}
          </select>
        </label>
      ) : null}
      <label className="field participant-barcode-variable-field">
        <span>Shared barcode question variable</span>
        <input
          value={barcodeVariable}
          disabled={Boolean(folderParticipantIdentifierVariable) || identifierActivated}
          placeholder="participant_barcode"
          onChange={(event) => setBarcodeVariable(slug(event.target.value))}
        />
        <small>{folderParticipantIdentifierVariable || identifierActivated ? "This variable is locked after changing the participant identifier." : "Choose this before changing the participant identifier. It will be shared by later forms in the folder."}</small>
      </label>
      {rows.length ? (
        <div className="participant-assignment-list">
          {rows.map((row) => (
            <div className="participant-assignment-row" key={row.id}>
              <div className="participant-assignment-details">
                <strong>{rowDisplayValue(row)}</strong>
                <small>Household: {row.householdIdentifier || "Not available"} · Repeat member {row.repeatIndex}</small>
              </div>
              <BarcodeCaptureField
                value={barcodeDrafts[row.id] || ""}
                disabled={status.kind === "busy"}
                onChange={(value) => setBarcodeDrafts((current) => ({ ...current, [row.id]: value }))}
              />
              <button className="primary small" type="button" disabled={status.kind === "busy" || !String(barcodeDrafts[row.id] || "").trim()} onClick={() => assign(row)}>
                {row.barcode ? "Update barcode" : "Assign barcode"}
              </button>
            </div>
          ))}
        </div>
      ) : <p className="muted">Submit at least one demographic form entry before assigning participant barcodes.</p>}
      <button
        className="primary participant-identifier-switch"
        type="button"
        disabled={identifierActivated || status.kind === "busy" || !rows.some((row) => row.barcode)}
        onClick={activateParticipantIdentifier}
      >
        {identifierActivated ? "Participant identifier is barcode" : "Update primary identification variable"}
      </button>
      {status.message ? <p className={`participant-assignment-status ${status.kind}`}>{status.message}</p> : null}
      </> : null}
    </section>
  );
}

function PreviewField({ question, value = "", onChange = () => {}, forceDisabled = false, languageMode = "default", choiceOptions = [], workspaceId = "", accessCode = "", cachedAttachments = {} }) {
  const disabled = Boolean(forceDisabled || question.readOnly || question.calculation);
  const calculated = Boolean(question.calculation);
  const label = localizedQuestion(question, "label", languageMode);
  const hint = String(localizedQuestion(question, "hint", languageMode) || "").trim();
  const hintNode = hint ? <small className="preview-hint">{hint}</small> : null;
  const options = question.options?.length ? question.options : choiceOptions;
  const renderMedia = (mediaType, source, className = "") => {
    const src = mediaSource(source, workspaceId, accessCode, cachedAttachments);
    if (!src) return null;
    if (mediaType === "image") return <img className={`respondent-media ${className}`} src={src} alt="" />;
    if (mediaType === "audio") return <audio className={`respondent-media ${className}`} controls src={src} />;
    if (mediaType === "video") return <video className={`respondent-media ${className}`} controls src={src} />;
    return <a className="media-file-link" href={src} target="_blank" rel="noreferrer">Open attached file</a>;
  };
  const renderOptionMedia = (option) => (
    <span className="choice-media">
      {renderMedia("image", option.image, "choice-media-image")}
      {renderMedia("image", option.bigImage || option["big-image"], "choice-media-image")}
      {renderMedia("audio", option.audio, "choice-media-audio")}
      {renderMedia("video", option.video, "choice-media-video")}
    </span>
  );
  const promptMediaNode = (
    <div className="prompt-media">
      {renderMedia("image", question.image)}
      {renderMedia("image", question.bigImage || question["big-image"])}
      {renderMedia("audio", question.audio)}
      {renderMedia("video", question.video)}
    </div>
  );
  if (question.type === "begin_group") {
    return (
      <section className="preview-group-heading">
        <h2>{label || question.name || "Section"}</h2>
        {hintNode}
      </section>
    );
  }
  if (question.type === "select_one" || question.type === "select_one_from_file") {
    return (
      <div className="preview-field">
        <span>{label}{calculated ? <em> calculated</em> : null}</span>
        {hintNode}
        {promptMediaNode}
        <div className="preview-options" role="radiogroup" aria-label={label || question.name}>
          {options.map((option) => (
            <label key={option.id || option.name}>
              <input
                type="radio"
                name={question.id || question.name}
                value={option.name}
                disabled={disabled}
                checked={String(value || "") === String(option.name)}
                onChange={(event) => onChange(event.target.value)}
              />
              <span>{localizedOption(option, "label", languageMode)}{renderOptionMedia(option)}</span>
            </label>
          ))}
        </div>
      </div>
    );
  }
  if (question.type === "select_multiple" || question.type === "select_multiple_from_file" || question.type === "rank") {
    const selected = new Set(String(value || "").split(" ").filter(Boolean));
    return (
      <div className="preview-field">
        <span>{label}</span>
        {hintNode}
        {promptMediaNode}
        <div className="preview-options">
          {options.map((option) => (
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
              <span>{localizedOption(option, "label", languageMode)}{renderOptionMedia(option)}</span>
            </label>
          ))}
        </div>
      </div>
    );
  }
  if (question.type === "note") {
    return <div className="preview-field note-field"><span>{label}</span>{hintNode}</div>;
  }
  if (question.type === "calculate") {
    return null;
  }
  if (["image", "audio", "video", "file", "background-audio"].includes(question.type) && !forceDisabled) {
    const accept = question.type === "image" ? "image/*" : question.type === "audio" || question.type === "background-audio" ? "audio/*" : question.type === "video" ? "video/*" : undefined;
    return (
      <label className="preview-field">
        <span>{label}</span>
        {hintNode}
        {renderMedia(question.type === "image" ? "image" : question.type === "audio" || question.type === "background-audio" ? "audio" : question.type === "video" ? "video" : "file", value)}
        <input
          type="file"
          accept={accept}
          capture={question.type === "image" || question.type === "audio" || question.type === "video" ? "environment" : undefined}
          disabled={disabled}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            try {
              onChange(await fileToDataUrl(file));
            } catch {
              onChange("");
            }
          }}
        />
      </label>
    );
  }
  if (["start", "end", "today", "deviceid", "username", "phonenumber", "email"].includes(question.type)) {
    return (
      <div className="preview-field system-field">
        <span>{label}</span>
        {hintNode}
        <input value={value} disabled readOnly />
      </div>
    );
  }
  if (question.type === "audit") {
    return <div className="preview-field note-field"><span>{label || "Audit metadata"}</span><small>Captured automatically by ODK when available.</small></div>;
  }
  if (question.type === "barcode") {
    return (
      <div className="preview-field">
        <span>{label}</span>
        {hintNode}
        <BarcodeCaptureField value={value} disabled={disabled} onChange={onChange} />
      </div>
    );
  }
  if (question.type === "acknowledge") {
    return (
      <label className="preview-field acknowledge-field">
        <span>{label}</span>
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
        <span>{label}</span>
        {hintNode}
        <p>Captured automatically when the ODK form opens.</p>
        {value ? <code>{value}</code> : null}
      </div>
    );
  }
  if (question.type === "geopoint") {
    return <LocationCaptureField question={question} value={value} onChange={onChange} disabled={disabled} label={label} hintNode={hintNode} />;
  }
  if (question.type === "geotrace" || question.type === "geoshape") {
    return <LocationCaptureField question={question} value={value} onChange={onChange} disabled={disabled} label={label} hintNode={hintNode} />;
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
  const rangeAppearance = String(question.appearance || "").trim().toLowerCase();
  const rangeStart = question.type === "range" ? parameterValue(question.parameters, "start", "1") : "";
  const rangeEnd = question.type === "range" ? parameterValue(question.parameters, "end", "10") : "";
  const rangeStep = question.type === "range" ? parameterValue(question.parameters, "step", "1") : "";
  const rangeIsPicker = question.type === "range" && rangeAppearance === "picker";
  const rangeIsVertical = question.type === "range" && rangeAppearance === "vertical";
  return (
    <label className="preview-field">
      <span>{label}</span>
      {hintNode}
      {promptMediaNode}
      {question.type === "range" ? (
        rangeIsPicker ? (
          <input
            className="range-picker-input"
            type="number"
            min={rangeStart}
            max={rangeEnd}
            step={rangeStep}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <div className={`range-preview ${rangeIsVertical ? "vertical" : "horizontal"}`}>
            {rangeIsVertical ? <span>{rangeEnd}</span> : <span>{rangeStart}</span>}
            <input
              type="range"
              min={rangeStart}
              max={rangeEnd}
              step={rangeStep}
              value={value}
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
            />
            {rangeIsVertical ? <span>{rangeStart}</span> : <span>{rangeEnd}</span>}
          </div>
        )
      ) : (
        <input
          type={inputType}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
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

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const input = String(text || "");
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (character === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => String(value).trim())) rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map((value) => String(value || "").trim().toLowerCase());
  const valueIndex = headers.indexOf("name") >= 0 ? headers.indexOf("name") : headers.indexOf("value");
  const labelIndex = headers.indexOf("label") >= 0 ? headers.indexOf("label") : valueIndex;
  if (valueIndex < 0) return [];
  return rows.slice(1)
    .map((values, index) => ({
      id: `external_choice_${index + 1}`,
      name: String(values[valueIndex] || "").trim(),
      label: String(values[labelIndex] || values[valueIndex] || "").trim()
    }))
    .filter((option) => option.name);
}

function parameterValue(parameters, key, fallback = "") {
  const match = String(parameters || "").match(new RegExp(`(?:^|\\s)${escapeRegExp(key)}=([^\\s]+)`));
  return match ? match[1] : fallback;
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

function CurrentLocationReferenceMap() {
  const [position, setPosition] = useState(null);
  const [locationError, setLocationError] = useState("");
  const zoom = 13;
  const tileSize = 256;

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationError("Location is not available in this browser.");
      return undefined;
    }
    const watchId = navigator.geolocation.watchPosition(
      ({ coords }) => {
        setPosition({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy });
        setLocationError("");
      },
      () => setLocationError("Allow location access to show the device reference point."),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  if (!position) {
    return (
      <div className="location-reference-map location-reference-empty">
        <MapPin size={18} />
        <span>{locationError || "Getting current device location..."}</span>
      </div>
    );
  }

  const scale = 2 ** zoom;
  const centerX = ((position.longitude + 180) / 360) * scale;
  const latitudeRadians = (position.latitude * Math.PI) / 180;
  const centerY = ((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * scale;
  const centerTileX = Math.floor(centerX);
  const centerTileY = Math.floor(centerY);
  const fractionalX = centerX - centerTileX;
  const fractionalY = centerY - centerTileY;
  const tiles = [];
  for (let row = -1; row <= 1; row += 1) {
    for (let column = -1; column <= 1; column += 1) {
      const tileX = centerTileX + column;
      const tileY = centerTileY + row;
      const wrappedX = ((tileX % scale) + scale) % scale;
      if (tileY < 0 || tileY >= scale) continue;
      tiles.push(
        <img
          key={`${tileX}-${tileY}`}
          className="location-reference-tile"
          style={{ left: `${(column + 1 - fractionalX) * tileSize}px`, top: `${(row + 1 - fractionalY) * tileSize}px` }}
          src={`https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`}
          alt=""
        />
      );
    }
  }
  return (
    <section className="location-reference-card" aria-label="Current device location reference">
      <div className="location-reference-head">
        <div><strong>Current device location</strong><span>Reference only. This marker cannot be moved or submitted as the answer.</span></div>
        <MapPin size={18} />
      </div>
      <div className="location-reference-map">
        <div className="location-reference-tiles">{tiles}</div>
        <span className="location-reference-marker" aria-label="Current device location" />
        <small className="location-reference-attribution">© OpenStreetMap contributors</small>
      </div>
      <code>{position.latitude.toFixed(6)}, {position.longitude.toFixed(6)} · ±{Math.round(position.accuracy || 0)} m</code>
    </section>
  );
}

function OdkWebFormIsland({ form, formXml, workspaceId, formApiBase, onSubmitted, onError, mapPicker = false, onMapSelected, mapPickerSelectRef = null, offlineCapable = false, cachedAttachmentUrls = {} }) {
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
    let buttonObserver = null;
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
      if (mapPicker) {
        const document = new DOMParser().parseFromString(instanceXml, "text/xml");
        const value = document.getElementsByTagName("location")[0]?.textContent?.trim() || "";
        const [latitude, longitude] = value.split(/\s+/).map(Number);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          onMapSelected?.({ latitude: Number(latitude.toFixed(6)), longitude: Number(longitude.toFixed(6)) });
        }
        return;
      }
      instanceXml = injectTimerValuesIntoXml(instanceXml, finalizeTimersRef.current());
      const attachmentFiles = new Map();
      for (const item of dataItems) {
        if (typeof item?.entries !== "function") continue;
        for (const [fileName, file] of item.entries()) {
          if (fileName === "xml_submission_file" || !(file instanceof Blob)) continue;
          attachmentFiles.set(file.name || fileName, file);
        }
      }
      const attachments = await Promise.all([...attachmentFiles.entries()].map(async ([fileName, file]) => ({
        fileName,
        contentType: file.type || "application/octet-stream",
        dataBase64: await fileToBase64(file)
      })));
      const payloadBody = {
        instanceXml,
        payloadType: payload?.payloadType || "monolithic",
        submissionMeta: payload?.submissionMeta || null,
        attachments
      };
      if (!offlineCapable) return postJson(`${apiBase}/odk-submissions`, payloadBody).then(() => ({ queued: false, pendingCount: 0 }));
      return saveOfflineFirst(`${apiBase}/odk-submissions`, payloadBody);
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
                const cachedUrl = cachedAttachmentUrls[resourceFileKey(fileName)];
                if (cachedUrl) return fetch(cachedUrl);
                return fetch(`${API_BASE}${apiBase}/attachments/${encodeURIComponent(fileName)}`, { headers: adminAuthHeaders() });
              },
              onSubmit: (payload, done) => {
                const completion = submitOdkPayload(payload)
                  .then((result) => {
                    submittedRef.current?.(result);
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
        if (mapPicker) {
          const renameSubmitButton = () => {
            mountPoint.querySelectorAll("button").forEach((button) => {
              if (button.textContent?.trim() === "Send") {
                button.style.display = "none";
                button.setAttribute("aria-hidden", "true");
              }
              if (button.textContent?.trim() === "Select") {
                button.style.display = "none";
                button.setAttribute("aria-hidden", "true");
              }
            });
          };
          renameSubmitButton();
          buttonObserver = new MutationObserver(renameSubmitButton);
          buttonObserver.observe(mountPoint, { childList: true, subtree: true });
          if (mapPickerSelectRef) {
            mapPickerSelectRef.current = () => {
              const button = [...mountPoint.querySelectorAll("button")].find((item) => /^(send|select)$/i.test(item.textContent?.trim() || ""));
              button?.click();
            };
          }
        }
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
      buttonObserver?.disconnect();
      if (mapPickerSelectRef) mapPickerSelectRef.current = null;
      if (app) app.unmount();
    };
  }, [apiBase, cachedAttachmentUrls, formXml, offlineCapable, workspaceId, mapPicker]);

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
  info = "",
  below = null
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
    if (readOnly) return;
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
        <Toggle label={toggleLabel} hideLabel checked={open} disabled={readOnly} onChange={enableCondition} />
      </div>

      {!open ? (
        <p className="logic-muted">{emptyText}</p>
      ) : (
        <>
          <div className="logic-tabs">
            <button className={state.mode === "guided" ? "active" : ""} disabled={!sources.length} onClick={() => setMode("guided")}>Builder</button>
            <button className={state.mode === "raw" ? "active" : ""} onClick={() => setMode("raw")}>Raw</button>
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
          {below}
        </>
      )}
    </div>
  );
}

function RequiredAnswerCard({ question, updateQuestion, readOnly = false, secondaryLanguage = "", secondaryValue = "", onSecondaryChange }) {
  const enabled = Boolean(question.required);
  return (
    <div className="logic-card">
      <div className="logic-card-head">
        <div>
          <span className="logic-title-row">
            <h3>Required</h3>
            <InfoButton label="Required">ODK XLS format: "required" column. Makes the respondent provide an answer before continuing.</InfoButton>
          </span>
          <small>ODK XLS format: "required" and "required_message" columns.</small>
        </div>
        <Toggle label="Required" hideLabel checked={enabled} disabled={readOnly} onChange={(value) => updateQuestion(question.id, { required: value })} />
      </div>
      {enabled ? (
        <div className="logic-card-body">
          <Field
            label="Required message"
            value={question.requiredMessage}
            disabled={readOnly}
            helpText={'ODK XLS format: "required_message" column.'}
            info={columnInfoText("required_message")}
            onChange={(value) => updateQuestion(question.id, { requiredMessage: value })}
            secondaryLabel={secondaryLanguage}
            secondaryValue={secondaryValue}
            onSecondaryChange={onSecondaryChange}
          />
        </div>
      ) : <p className="logic-muted">This question is optional.</p>}
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
  if (config.preset === "random_participant_id") {
    const length = Math.max(1, Math.min(128, Number(config.randomLength) || 12));
    const prefix = expressionLiteral(config.randomPrefix ?? "P-");
    const suffix = expressionLiteral(config.randomSuffix ?? "");
    return `once(concat('${prefix}', uuid(${length}), '${suffix}'))`;
  }
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
  const base = { mode: "preset", preset: "today", fieldA: firstSource, fieldB: secondSource, separator: " ", numberValue: "0", randomLength: "12", randomPrefix: "P-", randomSuffix: "" };
  if (!text) return base;
  if (text === "today()") return { ...base, preset: "today" };
  if (text === "now()") return { ...base, preset: "now" };
  if (text === "''") return { ...base, preset: "empty" };
  if (text === "once(concat('P-', uuid()))") return { ...base, preset: "random_participant_id" };
  let randomMatch = text.match(/^once\(concat\('((?:\\'|[^'])*)', uuid\((\d+)\), '((?:\\'|[^'])*)'\)\)$/);
  if (randomMatch) {
    return {
      ...base,
      preset: "random_participant_id",
      randomPrefix: randomMatch[1].replace(/\\'/g, "'"),
      randomLength: randomMatch[2],
      randomSuffix: randomMatch[3].replace(/\\'/g, "'")
    };
  }
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
  if (["calculate", "hidden", "text"].includes(type)) {
    options.push(
      { value: "today", label: "Today" },
      { value: "now", label: "Current date-time" },
      { value: "random_participant_id", label: "Generate random Participant ID" }
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
  return !["today", "now", "empty", "random_participant_id"].includes(preset);
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
  const [enabled, setEnabled] = useState(Boolean(String(value || "").trim()));
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
    if (readOnly) return;
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
        <Toggle
          label="Enable default answer"
          hideLabel
          checked={enabled}
          disabled={readOnly}
          onChange={(checked) => {
            setEnabled(checked);
            if (!checked) onChange("");
          }}
        />
      </div>
      {enabled ? <fieldset className="logic-card-body">
      <div className="logic-tabs">
        <button className={state.mode === "static" ? "active" : ""} onClick={() => commit({ ...state, mode: "static" })}>Fixed</button>
        <button className={state.mode === "builder" ? "active" : ""} onClick={() => commit({ ...state, mode: "builder" })}>Builder</button>
        <button className={state.mode === "raw" ? "active" : ""} onClick={() => commit({ ...state, mode: "raw", rawValue: value || "" })}>Raw</button>
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
      </fieldset> : <p className="logic-muted">No default answer is configured.</p>}
    </div>
  );
}

function CalculationBuilderCard({ form, question, value, onChange, readOnly = false }) {
  const sources = useMemo(() => calculationSources(form, question), [form, question]);
  const sourceKey = sources.map((source) => source.name).join("|");
  const stateKey = `${question.id}:calculation`;
  const [state, setState] = useState(() => initialCalculationState(value, sources));
  const [enabled, setEnabled] = useState(Boolean(String(value || "").trim()));
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
    if (readOnly) return;
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
        <Toggle
          label="Enable calculated value"
          hideLabel
          checked={enabled}
          disabled={readOnly}
          onChange={(checked) => {
            setEnabled(checked);
            if (!checked) onChange("");
          }}
        />
      </div>
      {enabled ? <fieldset className="logic-card-body">
      <div className="logic-tabs">
        <button className={state.mode === "preset" ? "active" : ""} onClick={() => commit({ ...state, mode: "preset" })}>Builder</button>
        <button className={state.mode === "raw" ? "active" : ""} onClick={() => commit({ ...state, mode: "raw" })}>Raw</button>
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
          {currentPreset === "random_participant_id" ? (
            <>
              <label className="logic-inline-field">
                <span>Random ID length</span>
                <input
                  type="number"
                  min="1"
                  max="128"
                  value={state.randomLength || "12"}
                  disabled={readOnly}
                  onChange={(event) => commit({ ...state, randomLength: event.target.value })}
                />
              </label>
              <label className="logic-inline-field">
                <span>Starts with</span>
                <input value={state.randomPrefix ?? "P-"} disabled={readOnly} placeholder="P-" onChange={(event) => commit({ ...state, randomPrefix: event.target.value })} />
              </label>
              <label className="logic-inline-field">
                <span>Ends with</span>
                <input value={state.randomSuffix ?? ""} disabled={readOnly} placeholder="Optional suffix" onChange={(event) => commit({ ...state, randomSuffix: event.target.value })} />
              </label>
              <small className="logic-muted">The generated random section is alphanumeric. Prefix and suffix characters are added outside the selected random length.</small>
            </>
          ) : null}
        </div>
      )}
      <div className="expression-preview">
        <span>Saved XLSForm expression</span>
        <code>{generatedExpression || "No expression generated yet"}</code>
      </div>
      </fieldset> : <p className="logic-muted">No calculated value is configured.</p>}
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
    if (readOnly) return;
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
        <Toggle label="Filter choices" hideLabel checked={open} disabled={readOnly} onChange={enableFilter} />
      </div>
      {!open ? (
        <p className="logic-muted">All choices are shown.</p>
      ) : (
        <>
          <div className="logic-tabs">
            <button className={mode === "guided" ? "active" : ""} disabled={!sources.length} onClick={() => { setMode("guided"); if (!readOnly) onChange(buildChoiceFilterExpression(rows), { mode: "guided", rows }); }}>Builder</button>
            <button className={mode === "raw" ? "active" : ""} onClick={() => { setMode("raw"); if (!readOnly) onChange(value || "", { mode: "raw" }); }}>Raw</button>
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
    if (readOnly) return;
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
        <button className={mode === "fixed" ? "active" : ""} onClick={() => commit("fixed")}>Fixed</button>
        <button className={mode === "answer" ? "active" : ""} disabled={!sources.length} onClick={() => commit("answer", fixed, sources[0]?.name || "")}>Answer</button>
        <button className={mode === "raw" ? "active" : ""} onClick={() => commit("raw")}>Raw</button>
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

function DemographicRepeatCard({ question, onChange, readOnly = false }) {
  if (question.type !== "begin_repeat") return null;
  return (
    <div className="logic-card demographic-repeat-card">
      <div className="logic-card-head">
        <div>
          <span className="logic-title-row"><h3>Demographic data</h3><InfoButton label="Demographic data">Marks this repeat as a roster of household or group members. ICPH uses this metadata for generated member IDs and later participant selection.</InfoButton></span>
          <small>This is ICPH workflow metadata and is not exported as an XLSForm column.</small>
        </div>
        <Toggle
          label="Enable demographic data"
          hideLabel
          checked={Boolean(question.demographicData)}
          disabled={readOnly}
          onChange={(checked) => onChange({ demographicData: checked })}
        />
      </div>
      {question.demographicData ? (
        <div className="logic-card-body">
          <Toggle
            label="Prefix generated member ID with parent identifier"
            checked={Boolean(question.prefixWithParentIdentifier)}
            disabled={readOnly}
            onChange={(checked) => onChange({ prefixWithParentIdentifier: checked })}
          />
          <p className="logic-muted">The parent identifier is chosen at publish time. The generated ID question is added as the first question in this repeat.</p>
        </div>
      ) : null}
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

function normalizeParameterRows(question, rows) {
  if (rows === null) return null;
  if (question.type !== "range") return rows;
  return (rows || []).map((row) => ({
    ...row,
    key: row.key === "tick-interval" ? "tick_interval" : row.key === "tick-labelset" ? "tick_labelset" : row.key
  }));
}

function buildParameterExpression(rows, question = {}) {
  return (rows || [])
    .map((row) => {
      const normalizedKey = question.type === "range" && ["tick_interval", "tick_labelset"].includes(row.key)
        ? row.key
        : row.key === "tick-interval" && question.type === "range"
          ? "tick_interval"
          : row.key === "tick-labelset" && question.type === "range"
            ? "tick_labelset"
            : row.key;
      const key = slug(normalizedKey || "").replace(/_/g, "-");
      if (!key || row.value === "") return "";
      const savedKey = question.type === "range" && ["tick_interval", "tick_labelset"].includes(normalizedKey)
        ? normalizedKey
        : key;
      return `${savedKey}=${String(row.value || "").trim()}`;
    })
    .filter(Boolean)
    .join(" ");
}

function parameterSuggestions(question) {
  if (question.type === "range") return ["start", "end", "step", "tick_interval", "placeholder", "tick_labelset"];
  if (question.type === "image") return ["max-pixels", "quality"];
  if (question.type === "audio" || question.type === "video" || question.type === "background-audio") return ["max-duration"];
  if (question.type === "file") return ["accept"];
  if (question.type === "barcode") return ["formats"];
  return ["key"];
}

function parameterKeyHelp(question, key) {
  const help = {
    range: {
      start: "Lowest selectable number. Defaults to 1.",
      end: "Highest selectable number. Defaults to 10.",
      step: "Distance between selectable values. Use decimals for decimal answers.",
      tick_interval: "Optional spacing between visible number-line tick marks. It must be an exact multiple of step, for example step=5 and tick_interval=10.",
      placeholder: "Optional value shown before the respondent makes a selection.",
      tick_labelset: "Optional choices list name for labels on selected tick marks."
    },
    image: { "max-pixels": "Maximum image dimensions in pixels.", quality: "Image quality setting." },
    audio: { "max-duration": "Maximum recording duration in seconds." },
    video: { "max-duration": "Maximum recording duration in seconds." },
    "background-audio": { "max-duration": "Maximum recording duration in seconds." },
    barcode: { formats: "Allowed barcode formats, when supported by the device scanner." }
  };
  return help[question.type]?.[key] || "ODK parameter value for this question widget.";
}

function parameterValueMeta(question, key) {
  if (question.type === "range") {
    if (["start", "end", "step", "tick_interval", "placeholder"].includes(key)) {
      return { type: "number", inputMode: "decimal", placeholder: key === "placeholder" ? "e.g. 50" : key === "tick_interval" ? "e.g. 25" : key === "start" ? "e.g. 0" : key === "end" ? "e.g. 10" : "e.g. 1" };
    }
    if (key === "tick_labelset") return { type: "text", placeholder: "e.g. agreement_labels" };
  }
  return { type: "text", placeholder: "value" };
}

const FILE_ACCEPT_PRESETS = [
  { value: "", label: "Any file type" },
  { value: "image/*", label: "Images only" },
  { value: "application/pdf", label: "PDF only" },
  { value: ".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "DOC and DOCX" },
  { value: "image/*,application/pdf", label: "Images and PDF" },
  { value: "audio/*", label: "Audio only" },
  { value: "video/*", label: "Video only" }
];

function FileAcceptField({ value, onChange, readOnly = false }) {
  const knownPreset = FILE_ACCEPT_PRESETS.some((preset) => preset.value === value);
  const [custom, setCustom] = useState(Boolean(value && !knownPreset));
  const selectedValue = custom ? "custom" : value;

  useEffect(() => {
    setCustom(Boolean(value && !FILE_ACCEPT_PRESETS.some((preset) => preset.value === value)));
  }, [value]);

  return (
    <div className="file-accept-field">
      <label className="field">
        <span>Allowed file types</span>
        <select
          value={selectedValue}
          disabled={readOnly}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "custom") {
              setCustom(true);
              return;
            }
            setCustom(false);
            onChange(next);
          }}
        >
          {FILE_ACCEPT_PRESETS.map((preset) => <option key={preset.label} value={preset.value}>{preset.label}</option>)}
          <option value="custom">Custom MIME types or extensions</option>
        </select>
      </label>
      {custom ? (
        <label className="field">
          <span>Custom types</span>
          <input
            value={value || ""}
            disabled={readOnly}
            placeholder="image/*, application/pdf, .csv"
            onChange={(event) => onChange(event.target.value)}
          />
          <small>Separate MIME types or extensions with commas, for example <code>image/*, application/pdf, .csv</code>.</small>
        </label>
      ) : null}
      <p className="logic-muted">Respondents will only be able to choose files matching this ODK <code>accept</code> rule.</p>
    </div>
  );
}

function ParametersBuilderCard({ question, value, onChange, readOnly = false }) {
  const stateKey = `${question.id}:parameters`;
  const parsedRows = normalizeParameterRows(question, parseParameterRows(value));
  const [mode, setMode] = useState(String(value || "").trim() && parsedRows === null ? "raw" : "guided");
  const [enabled, setEnabled] = useState(Boolean(String(value || "").trim()));
  const [rows, setRows] = useState(parsedRows?.length ? parsedRows : [{ id: crypto.randomUUID(), key: parameterSuggestions(question)[0], value: "" }]);
  useEffect(() => {
    const nextRows = normalizeParameterRows(question, parseParameterRows(value));
    setMode(String(value || "").trim() && nextRows === null ? "raw" : "guided");
    setRows(nextRows?.length ? nextRows : [{ id: crypto.randomUUID(), key: parameterSuggestions(question)[0], value: "" }]);
  }, [stateKey]);
  const generatedExpression = mode === "guided" ? buildParameterExpression(rows, question) : String(value || "");
  const parameterIssue = question.type === "range"
    ? rangeParametersIssue({ ...question, parameters: generatedExpression })
    : "";
  const suggestions = parameterSuggestions(question);
  const fileAcceptValue = rows.find((row) => String(row.key || "").trim().toLowerCase() === "accept")?.value || "";
  const visibleRows = question.type === "file"
    ? rows.filter((row) => String(row.key || "").trim().toLowerCase() !== "accept")
    : rows;

  function commit(nextRows) {
    const normalizedRows = normalizeParameterRows(question, nextRows);
    setRows(normalizedRows);
    if (readOnly) return;
    onChange(buildParameterExpression(normalizedRows, question), { mode: "guided", rows: normalizedRows });
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
        <Toggle
          label="Enable parameters"
          hideLabel
          checked={enabled}
          disabled={readOnly}
          onChange={(checked) => {
            setEnabled(checked);
            if (!checked) onChange("");
          }}
        />
      </div>
      {enabled ? <fieldset className="logic-card-body">
      {question.type === "range" ? (
        <p className="logic-muted parameter-help">
          Choose <strong>start</strong>, <strong>end</strong>, and <strong>step</strong> to define the range. Optional keys control ticks and labels.
        </p>
      ) : null}
      {question.type === "file" && mode === "guided" ? (
        <FileAcceptField
          value={fileAcceptValue}
          readOnly={readOnly}
          onChange={(nextValue) => {
            const withoutAccept = rows.filter((row) => String(row.key || "").trim().toLowerCase() !== "accept");
            const nextRows = nextValue
              ? [{ id: rows.find((row) => String(row.key || "").trim().toLowerCase() === "accept")?.id || crypto.randomUUID(), key: "accept", value: nextValue }, ...withoutAccept]
              : withoutAccept;
            commit(nextRows);
          }}
        />
      ) : null}
      <div className="logic-tabs">
        <button className={mode === "guided" ? "active" : ""} onClick={() => { setMode("guided"); if (!readOnly) onChange(buildParameterExpression(rows, question), { mode: "guided", rows }); }}>Builder</button>
        <button className={mode === "raw" ? "active" : ""} onClick={() => { setMode("raw"); if (!readOnly) onChange(value || "", { mode: "raw" }); }}>Raw</button>
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
          {visibleRows.map((row) => (
            <div className="parameter-rule" key={row.id}>
              <div className="parameter-key-field">
                <div className="parameter-key-row">
                  <InfoButton label={`${row.key || "custom"} parameter`}>{parameterKeyHelp(question, row.key)}</InfoButton>
                  <select
                    value={suggestions.includes(row.key) ? row.key : "__custom"}
                    disabled={readOnly}
                    aria-label="Parameter key"
                    onChange={(event) => commit(rows.map((item) => item.id === row.id ? { ...item, key: event.target.value === "__custom" ? "" : event.target.value } : item))}
                  >
                    {suggestions.map((item) => <option key={item} value={item}>{item}</option>)}
                    <option value="__custom">Custom key...</option>
                  </select>
                </div>
                {!suggestions.includes(row.key) ? (
                  <input
                    value={row.key || ""}
                    disabled={readOnly}
                    placeholder="custom key"
                    onChange={(event) => commit(rows.map((item) => item.id === row.id ? { ...item, key: event.target.value } : item))}
                  />
                ) : null}
              </div>
              {(() => {
                const meta = parameterValueMeta(question, row.key);
                return (
              <input
                type={meta.type}
                inputMode={meta.inputMode}
                value={row.value || ""}
                disabled={readOnly}
                placeholder={meta.placeholder}
                onChange={(event) => commit(rows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))}
              />
                );
              })()}
              <button className="icon-button danger" disabled={readOnly || rows.length <= 1} onClick={() => commit(rows.filter((item) => item.id !== row.id))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {question.type !== "file" ? (
            <button className="secondary small" disabled={readOnly} onClick={() => commit([...rows, { id: crypto.randomUUID(), key: suggestions[0], value: "" }])}>
              <Plus size={14} /> Add parameter
            </button>
          ) : null}
        </div>
      )}
      <div className="expression-preview">
        <span>Saved XLSForm value</span>
        <code>{generatedExpression || "No parameters"}</code>
      </div>
      {parameterIssue ? <p className="logic-error">{parameterIssue}</p> : null}
      </fieldset> : <p className="logic-muted">No parameters are configured.</p>}
    </div>
  );
}

const ADVANCED_ODK_COLUMNS = [
  { key: "bind::type", label: "Bind data type", placeholder: "decimal, dateTime, int..." },
  { key: "preload", label: "Preload", placeholder: "timestamp, property..." },
  { key: "preloadParams", label: "Preload parameters", placeholder: "deviceid, subscriberid..." },
  { key: "odk:length", label: "ODK length", placeholder: "10" },
  { key: "jr:choice-name", label: "Choice name expression", placeholder: "jr:choice-name(...)" }
];

function AdvancedOdkColumnsCard({ question, updateQuestion, readOnly = false }) {
  const columns = question.extraColumns && typeof question.extraColumns === "object" ? question.extraColumns : {};
  const knownKeys = new Set(ADVANCED_ODK_COLUMNS.map((item) => item.key));
  const customRows = Object.entries(columns).filter(([key, value]) => !knownKeys.has(key) && String(value || "").trim());

  function updateColumn(key, value) {
    const next = { ...(question.extraColumns || {}) };
    if (String(value || "").trim()) next[key] = value;
    else delete next[key];
    updateQuestion(question.id, { extraColumns: next });
  }

  return (
    <details className="logic-card advanced-odk-card">
      <summary>
        <span>
          <strong>Advanced ODK settings</strong>
          <small>Optional survey-sheet columns for imported or specialist XLSForms.</small>
        </span>
        <InfoButton label="Advanced ODK settings">These values are written to the survey sheet exactly as entered. Use only columns supported by your ODK runtime.</InfoButton>
      </summary>
      <div className="advanced-odk-fields">
        {ADVANCED_ODK_COLUMNS.map((column) => (
          <label className="field" key={column.key}>
            <span>{column.label} <code>{column.key}</code></span>
            <input
              value={columns[column.key] || ""}
              disabled={readOnly}
              placeholder={column.placeholder}
              onChange={(event) => updateColumn(column.key, event.target.value)}
            />
          </label>
        ))}
        {customRows.map(([key, value]) => (
          <div className="advanced-odk-custom-row" key={key}>
            <input value={key} disabled aria-label="Custom ODK column name" />
            <input value={value} disabled={readOnly} aria-label={`Value for ${key}`} onChange={(event) => updateColumn(key, event.target.value)} />
            <button className="icon-button danger" type="button" disabled={readOnly} onClick={() => updateColumn(key, "")} aria-label={`Remove ${key}`}><Trash2 size={14} /></button>
          </div>
        ))}
        <button
          className="secondary small"
          type="button"
          disabled={readOnly}
          onClick={() => {
            const key = window.prompt("ODK survey column name", "your:column");
            if (key?.trim()) {
              const value = window.prompt(`Value for ${key.trim()}`, "") || "";
              updateColumn(key.trim(), value);
            }
          }}
        >
          <Plus size={14} /> Add custom ODK column
        </button>
      </div>
    </details>
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
        <Toggle label="Recalculate when another answer changes" hideLabel checked={open} disabled={readOnly || !hasCalculation} onChange={enableTrigger} />
      </div>
      {!hasCalculation ? (
        <p className="logic-muted">Add a Calculated value first. A trigger only controls when that calculation reruns.</p>
      ) : !open ? (
        <p className="logic-muted">This calculated value will not be rerun by another answer changing.</p>
      ) : (
        <>
          <div className="logic-tabs">
            <button className={mode === "guided" ? "active" : ""} disabled={!sources.length} onClick={() => { setMode("guided"); if (!readOnly) onChange(sourceName ? fieldReference(sourceName) : "", { mode: "guided", sourceName }); }}>Builder</button>
            <button className={mode === "raw" ? "active" : ""} onClick={() => { setMode("raw"); if (!readOnly) onChange(value || "", { mode: "raw" }); }}>Raw</button>
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
  select_one: ["", "map", "minimal", "autocomplete", "compact", "quickcompact", "label", "list-nolabel"],
  select_multiple: ["", "map", "minimal", "compact", "quickcompact", "label", "list-nolabel"],
  rank: ["", "minimal"],
  image: ["", "annotate", "draw", "signature", "new", "selfie"],
  geopoint: ["", "maps", "placement-map", "hide-input"],
  geotrace: ["", "maps"],
  geoshape: ["", "maps"],
  range: ["", "horizontal", "vertical", "picker", "no-ticks", "rating"],
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
      {question.type === "range" ? (
        <small className="appearance-help">
          Default or horizontal = number line; vertical = low-to-high vertical number line; picker = spinner-style number picker in ODK Collect; rating = stars.
        </small>
      ) : null}
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

const GEOMETRY_POINT_PICKER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:jr="http://openrosa.org/javarosa">
  <h:head>
    <h:title>Choose map point</h:title>
    <model>
      <instance><data id="icph_geometry_picker"><location /></data></instance>
      <bind nodeset="/data/location" type="geopoint" required="true()" />
    </model>
  </h:head>
  <h:body><input ref="/data/location" appearance="placement-map"><label>Choose a point</label></input></h:body>
</h:html>`;

function GeopointOptionPicker({ onAdd, onClose }) {
  const [mapView, setMapView] = useState({ center: { latitude: 20, longitude: 78 }, zoom: 5 });
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [label, setLabel] = useState("");
  const tileSize = 256;
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  const mapSelectRef = useRef(null);

  useEffect(() => {
    if (!navigator.geolocation) return undefined;
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      setMapView((current) => ({ ...current, center: { latitude: coords.latitude, longitude: coords.longitude } }));
    }, () => {});
    return undefined;
  }, []);

  function worldPoint(latitude, longitude) {
    const scale = 2 ** mapView.zoom;
    const x = ((longitude + 180) / 360) * scale;
    const latitudeRadians = (latitude * Math.PI) / 180;
    const y = ((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * scale;
    return { x, y };
  }

  function locationFromWorld(x, y) {
    const scale = 2 ** mapView.zoom;
    const longitude = (x / scale) * 360 - 180;
    const latitude = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) * 180) / Math.PI;
    return { latitude, longitude };
  }

  function pointFromClick(event) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const centerWorld = worldPoint(mapView.center.latitude, mapView.center.longitude);
    const worldX = centerWorld.x + ((event.clientX - (bounds.left + bounds.width / 2)) / tileSize);
    const worldY = centerWorld.y + ((event.clientY - (bounds.top + bounds.height / 2)) / tileSize);
    const { latitude, longitude } = locationFromWorld(worldX, worldY);
    setSelectedPoint({ latitude: Number(latitude.toFixed(6)), longitude: Number(longitude.toFixed(6)) });
  }

  function startPan(event) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
  }

  function movePan(event) {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.x;
    const dy = event.clientY - dragRef.current.y;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    dragRef.current.moved = true;
    const centerWorld = worldPoint(mapView.center.latitude, mapView.center.longitude);
    const nextCenter = locationFromWorld(centerWorld.x - dx / tileSize, centerWorld.y - dy / tileSize);
    setMapView((current) => ({ ...current, center: nextCenter }));
    dragRef.current.x = event.clientX;
    dragRef.current.y = event.clientY;
  }

  function endPan() {
    if (dragRef.current?.moved) suppressClickRef.current = true;
    dragRef.current = null;
  }

  function changeZoom(delta) {
    setMapView((current) => ({ ...current, zoom: Math.max(2, Math.min(18, current.zoom + delta)) }));
  }

  const zoom = mapView.zoom;
  const scale = 2 ** zoom;
  const centerWorld = worldPoint(mapView.center.latitude, mapView.center.longitude);
  const centerTileX = Math.floor(centerWorld.x);
  const centerTileY = Math.floor(centerWorld.y);
  const fractionalX = centerWorld.x - centerTileX;
  const fractionalY = centerWorld.y - centerTileY;
  const tiles = [];
  for (let row = -1; row <= 1; row += 1) {
    for (let column = -1; column <= 1; column += 1) {
      const tileX = centerTileX + column;
      const tileY = centerTileY + row;
      const wrappedX = ((tileX % scale) + scale) % scale;
      if (tileY < 0 || tileY >= scale) continue;
      tiles.push(
        <img
          key={`${tileX}-${tileY}`}
          className="location-reference-tile"
          style={{ left: `${(column + 1 - fractionalX) * tileSize}px`, top: `${(row + 1 - fractionalY) * tileSize}px` }}
          src={`https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`}
          alt=""
        />
      );
    }
  }
  const selectedWorld = selectedPoint ? worldPoint(selectedPoint.latitude, selectedPoint.longitude) : null;
  const markerLeft = selectedWorld ? `calc(50% + ${(selectedWorld.x - centerWorld.x) * tileSize}px)` : "50%";
  const markerTop = selectedWorld ? `calc(50% + ${(selectedWorld.y - centerWorld.y) * tileSize}px)` : "50%";

  function addPoint() {
    if (!selectedPoint) return;
    onAdd({
      name: `place_${Date.now().toString().slice(-6)}`,
      label: label.trim() || `Place ${selectedPoint.latitude.toFixed(4)}, ${selectedPoint.longitude.toFixed(4)}`,
      geometry: `POINT (${selectedPoint.longitude} ${selectedPoint.latitude})`
    });
    setSelectedPoint(null);
    setLabel("");
  }

  function handleMapSelected(point) {
    onAdd({
      name: `place_${Date.now().toString().slice(-6)}`,
      label: label.trim() || `Place ${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`,
      geometry: `POINT (${point.longitude} ${point.latitude})`
    });
    onClose();
  }

  return (
    <div className="geopoint-picker-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="geopoint-picker" role="dialog" aria-modal="true" aria-label="Add a map point">
        <div className="geopoint-picker-head">
          <div><strong>Add map point</strong><span>Click the map to place a point, then give it a choice label.</span></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close map point picker"><X size={16} /></button>
        </div>
        <div className="geopoint-picker-odk-map">
          <OdkWebFormIsland
            form={{ questions: [] }}
            formXml={GEOMETRY_POINT_PICKER_XML}
            workspaceId=""
            formApiBase=""
            mapPicker
            mapPickerSelectRef={mapSelectRef}
            onMapSelected={handleMapSelected}
            onSubmitted={() => {}}
            onError={() => {}}
          />
        </div>
        <div className="geopoint-picker-actions">
          <small className="muted">Move the point on the map, then select it.</small>
          <button className="primary" type="button" onClick={() => mapSelectRef.current?.()}><MapPin size={16} /> Select</button>
        </div>
      </div>
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

function QuestionEditor({ form, question, updateQuestion, uploadQuestionMedia, uploadOptionMedia, readOnly = false }) {
  const hasOptions = question.type === "select_one" || question.type === "select_multiple" || question.type === "rank";
  const hasExternalList = question.type === "select_one_from_file" || question.type === "select_multiple_from_file";
  const options = question.options || [];
  const isCalculate = question.type === "calculate";
  const isRank = question.type === "rank";
  const showChoiceGeometry = /map/i.test(String(question.appearance || ""));
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
  const secondaryLanguage = secondaryLanguageName(form);
  const [showGeopointPicker, setShowGeopointPicker] = useState(false);
  const [expandedOptionMedia, setExpandedOptionMedia] = useState({});
  const [mapGeometryOptionId, setMapGeometryOptionId] = useState("");
  const secondaryFieldProps = (key) => secondaryLanguage ? {
    secondaryLabel: secondaryLanguage,
    secondaryValue: translatedValue(question, key),
    onSecondaryChange: (value) => updateQuestion(question.id, withTranslatedValue(question, key, value))
  } : {};

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

  function addMapOption(option) {
    updateQuestion(question.id, {
      appearance: "map",
      options: [...options, { id: crypto.randomUUID(), ...option }]
    });
  }

  function removeOption(id) {
    updateQuestion(question.id, { options: options.filter((option) => option.id !== id) });
  }

  return (
    <div className="editor-stack">
      <div className="question-type-row">
        <QuestionTypeField
          question={question}
          readOnly={readOnly}
          onChange={(nextType) => updateQuestion(question.id, questionTypePatch(question, nextType))}
        />
        {showReadOnlyControls ? (
          <Toggle
            label="Read only"
            checked={question.readOnly || isCalculate}
            disabled={readOnly || isCalculate}
            onChange={(value) => updateQuestion(question.id, { readOnly: value })}
          />
        ) : null}
      </div>
      <StructuralTypeHelp type={question.type} />
      <LocationTypeHelp question={question} />
      <TimerTypeHelp question={question} />
      <TimerSettingsCard question={question} updateQuestion={updateQuestion} readOnly={readOnly} />
      {!END_STRUCTURAL_TYPES.has(question.type) ? (
        <>
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
            {...secondaryFieldProps("label")}
          />
          <Field
            label="Question hint"
            value={question.hint}
            disabled={readOnly}
            helpText={'ODK XLS format: "hint" column.'}
            info={columnInfoText("hint")}
            onChange={(value) => updateQuestion(question.id, { hint: value })}
            multiline
            {...secondaryFieldProps("hint")}
          />
          {hasOptions ? (
            <div className={`options-editor ${isRank ? "rank-items-editor" : ""}`}>
              <div className="section-head">
                <div>
                  <h3>{isRank ? "Items respondents will rank" : "Options"}</h3>
                  {isRank ? <p>Each row below is one item the respondent can place in order. The saved value is the item code; respondents see the display text.</p> : null}
                </div>
                <div className="section-actions">
                  {isRank ? <button className="secondary small" disabled={readOnly} onClick={addOption}><Plus size={14} /> Add Item</button> : null}
                  {!isRank ? <button className="secondary small" disabled={readOnly} onClick={() => setShowGeopointPicker((current) => !current)}><MapPin size={14} /> Add from map</button> : null}
                </div>
              </div>
              {showGeopointPicker ? <GeopointOptionPicker onAdd={addMapOption} onClose={() => setShowGeopointPicker(false)} /> : null}
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
                      {secondaryLanguage ? (
                        <input
                          value={translatedValue(option, "label")}
                          disabled={readOnly}
                          placeholder={`${secondaryLanguage} display text`}
                          onChange={(event) => updateOption(option.id, withTranslatedValue(option, "label", event.target.value))}
                        />
                      ) : null}
                    </label>
                    <button className="icon-button danger" disabled={readOnly} onClick={() => removeOption(option.id)}><Trash2 size={14} /></button>
                  </div>
                  <button
                    className="link-button option-media-toggle"
                    type="button"
                    onClick={() => setExpandedOptionMedia((current) => ({ ...current, [option.id]: !current[option.id] }))}
                  >
                    {expandedOptionMedia[option.id] ? "- media" : "+ media"}
                  </button>
                  {expandedOptionMedia[option.id] ? <div className="option-media-row">
                    {[
                      ["image", "Image", "image/*"],
                      ["bigImage", "Big image", "image/*"],
                      ["audio", "Audio", "audio/*"],
                      ["video", "Video", "video/*"]
                    ].map(([fieldName, label, accept]) => (
                      <label className="option-media-field" key={fieldName}>
                        <span>{label}</span>
                        <input value={option[fieldName] || ""} disabled={readOnly} placeholder="No file" onChange={(event) => updateOption(option.id, { [fieldName]: event.target.value })} />
                        <span className="secondary small file-action">
                          <Upload size={13} /> {option[fieldName] ? "Replace" : "Upload"}
                          <input
                            type="file"
                            accept={accept}
                            disabled={readOnly}
                            onChange={(event) => uploadOptionMedia?.(question.id, option.id, fieldName, event)}
                          />
                        </span>
                      </label>
                    ))}
                    {showChoiceGeometry ? (
                      <div className="option-geometry-field">
                        <span>Map geometry <InfoButton label="WKT geometry help">
                          <div className="wkt-help">
                            <strong>WKT format rules</strong>
                            <p><b>Coordinate order:</b> longitude (X) first, then latitude (Y), separated by a space.</p>
                            <p><b>Point:</b> <code>POINT (longitude latitude)</code></p>
                            <p><b>Line or polygon:</b> coordinate pairs are comma-separated, for example <code>LINESTRING (lon1 lat1, lon2 lat2)</code>.</p>
                            <p><b>Files:</b> plain-text <code>.txt</code> files are accepted as-is. A <code>.wkt</code> extension is optional; do not rename the file unless you prefer that extension.</p>
                          </div>
                        </InfoButton></span>
                        <input value={option.geometry || ""} disabled={readOnly} placeholder="WKT or geometry file" onChange={(event) => updateOption(option.id, { geometry: event.target.value })} />
                        <span className="secondary small file-action">
                          <Upload size={13} /> {option.geometry && looksLikeResourceFile(option.geometry) ? "Replace geometry file" : "Upload geometry file"}
                          <input
                            type="file"
                            accept=".geojson,.json,.wkt,.txt,application/geo+json,application/json,text/plain"
                            disabled={readOnly}
                            onChange={(event) => uploadOptionMedia?.(question.id, option.id, "geometry", event)}
                          />
                        </span>
                        {option.geometry ? (
                          <div className="geometry-saved-state">
                            <Check size={16} />
                            <span><strong>Map point saved</strong><code>{option.geometry}</code></span>
                          </div>
                        ) : null}
                        <button className="secondary small" type="button" disabled={readOnly} onClick={() => setMapGeometryOptionId((current) => current === option.id ? "" : option.id)}>
                          <MapPin size={13} /> {mapGeometryOptionId === option.id ? "Close map picker" : "Pick point on map"}
                        </button>
                        {mapGeometryOptionId === option.id ? (
                          <GeopointOptionPicker
                            onAdd={(pointOption) => {
                              updateOption(option.id, { geometry: pointOption.geometry });
                              setMapGeometryOptionId("");
                            }}
                            onClose={() => setMapGeometryOptionId("")}
                          />
                        ) : null}
                        <small>Optional. Paste WKT or upload a plain-text <code>.txt</code>/<code>.wkt</code> file. No renaming is required.</small>
                      </div>
                    ) : null}
                  </div> : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {showRequiredControls ? (
        <RequiredAnswerCard
          question={question}
          updateQuestion={updateQuestion}
          readOnly={readOnly}
          secondaryLanguage={secondaryLanguage}
          secondaryValue={translatedValue(question, "requiredMessage")}
          onSecondaryChange={(value) => updateQuestion(question.id, withTranslatedValue(question, "requiredMessage", value))}
        />
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
          below={showConstraint || hasColumnValue(question, "constraintMessage") ? (
            <Field
              label="Message for respondent about the above answering condition"
              value={question.constraintMessage}
              disabled={readOnly}
              helpText={'ODK XLS format: "constraint_message" column.'}
              info={columnInfoText("constraint_message")}
              onChange={(value) => updateQuestion(question.id, { constraintMessage: value })}
              {...secondaryFieldProps("constraintMessage")}
            />
          ) : null}
          onChange={(value, builderState) => updateQuestion(question.id, updateLogicPatch(question, "constraint", "constraint", value, builderState))}
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
      {question.type === "begin_repeat" ? (
        <DemographicRepeatCard
          question={question}
          readOnly={readOnly}
          onChange={(patch) => updateQuestion(question.id, patch)}
        />
      ) : null}
      {showQuestionNote ? <Field label="Designer note" value={question.note} disabled={readOnly} helpText={'ODK XLS format: "note" column.'} info={columnInfoText("note")} onChange={(value) => updateQuestion(question.id, { note: value })} multiline {...secondaryFieldProps("note")} /> : null}
      {showGuidanceHint ? <Field label="Guidance hint" value={question.guidanceHint} disabled={readOnly} helpText={'ODK XLS format: "guidance_hint" column.'} info={columnInfoText("guidance_hint")} onChange={(value) => updateQuestion(question.id, { guidanceHint: value })} multiline {...secondaryFieldProps("guidanceHint")} /> : null}
      {showEntitySaveTo ? <Field label="Entity save_to" value={question.saveTo} disabled={readOnly} helpText={'ODK XLS format: "save_to" column. Leave blank unless this form creates or updates ODK Entities.'} info={columnInfoText("save_to")} onChange={(value) => updateQuestion(question.id, { saveTo: value })} /> : null}
      <AdvancedOdkColumnsCard question={question} updateQuestion={updateQuestion} readOnly={readOnly} />
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

function FillForm({ workspaceId, accessCode, entryId = "", checkpointAnswers = null, resumePrimaryIdentifierValue = "", onBackToRespondent }) {
  const [form, setForm] = useState(null);
  const [formXml, setFormXml] = useState("");
  const [answers, setAnswers] = useState({});
  const [answersReady, setAnswersReady] = useState(false);
  const [cachedAttachmentUrls, setCachedAttachmentUrls] = useState({});
  const [offlineReady, setOfflineReady] = useState(false);
  const [localDraftSaved, setLocalDraftSaved] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const cachedPackageRef = useRef(null);
  const [activeGroupPage, setActiveGroupPage] = useState(0);
  const [editingEntry, setEditingEntry] = useState(null);
  const [languageMode, setLanguageMode] = useState("default");
  const [externalChoices, setExternalChoices] = useState({});
  const [submissionSuccess, setSubmissionSuccess] = useState(false);
  const [status, setStatus] = useState({ kind: "busy", message: "Loading form..." });
  const encodedWorkspaceId = workspaceId ? encodeURIComponent(workspaceRouteId(workspaceId)) : "";
  const encodedAccessCode = accessCode ? encodeURIComponent(normalizeAccessCodeInput(accessCode)) : "";
  const formApiBase = accessCode
    ? `/api/public/forms/${encodedAccessCode}`
    : `/api/forms/${encodedWorkspaceId}`;
  const calculatedAnswers = form ? computeCalculatedAnswers(form, answers) : answers;
  const questionsToShow = form ? visibleQuestions(form, calculatedAnswers) : [];
  const hasGroupSections = Boolean(form?.questions?.some((question) => question.type === "begin_group"));
  const hasChoiceQuestions = Boolean(form?.questions?.some((question) => (
    question.type === "select_one" ||
    question.type === "select_multiple" ||
    question.type === "select_one_from_file" ||
    question.type === "select_multiple_from_file" ||
    question.type === "rank"
  )));
  const groupPages = hasGroupSections ? groupedQuestionPages(questionsToShow) : [];
  const pageQuestions = hasGroupSections ? (groupPages[activeGroupPage] || []) : questionsToShow;
  const answerValidation = form ? validateAnswers(form, answers) : { answers: {}, errors: ["Form is not loaded."] };
  const pageValidation = form ? validateAnswers(form, answers, pageQuestions) : answerValidation;
  const canSubmit = Boolean(form && status.kind !== "busy" && !answerValidation.errors.length);
  const isLastGroupPage = !hasGroupSections || activeGroupPage >= groupPages.length - 1;
  const canAdvanceGroup = Boolean(form && status.kind !== "busy" && !pageValidation.errors.length);
  const secondaryLanguage = form ? secondaryLanguageName(form) : "";
  const hasBarcodeQuestions = Boolean(form?.questions?.some((question) => question.type === "barcode"));
  const useOdkViewer = Boolean(formXml && !hasGroupSections && !hasChoiceQuestions && !hasBarcodeQuestions && !editingEntry && !entryId && checkpointAnswers === null && !resumePrimaryIdentifierValue);

  useEffect(() => {
    setActiveGroupPage(0);
  }, [form?.formId, entryId, checkpointAnswers]);

  useEffect(() => {
    const updateOnlineState = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refreshQueue = async () => {
      try {
        const result = isOnline ? await syncPendingSubmissions() : null;
        const count = result?.pendingCount ?? await getPendingSubmissionCount();
        if (!cancelled) setPendingSyncCount(count);
      } catch {}
    };
    refreshQueue();
    window.addEventListener("focus", refreshQueue);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshQueue);
    };
  }, [isOnline]);

  useEffect(() => {
    if (!form || !answersReady || !accessCode) return undefined;
    const timeout = window.setTimeout(() => {
      saveEncryptedOfflineRecord("offlineDrafts", {
        id: offlineDraftId(accessCode, workspaceId, entryId),
        accessCode,
        answers,
        updatedAt: Date.now()
      }).then(() => setLocalDraftSaved(true)).catch(() => {});
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [accessCode, answers, answersReady, entryId, form, workspaceId]);

  useEffect(() => () => {
    Object.values(cachedAttachmentUrls).forEach((url) => URL.revokeObjectURL(url));
  }, [cachedAttachmentUrls]);

  useEffect(() => {
    async function loadPublishedForm() {
      try {
        let data;
        let draft;
        let publishedForm;
        let xml = "";
        let attachmentBlobs = [];
        let externalChoiceData = {};
        let loadedOffline = false;
        let packageCached = false;
        try {
          data = await requestJson(formApiBase);
          draft = normalizeFormDraft(data.draft);
          if (data.hasXml) {
            const xmlData = await requestJson(`${formApiBase}/xml`);
            xml = xmlData.xml || "";
            publishedForm = parseXFormXml(xml, draft);
          } else {
            publishedForm = draft;
          }
          const attachmentList = await requestJson(`${formApiBase}/attachments`).catch(() => ({ attachments: [] }));
          attachmentBlobs = await Promise.all((attachmentList.attachments || []).map(async (attachment) => {
            try {
              const response = await fetch(`${API_BASE}${formApiBase}/attachments/${encodeURIComponent(attachment.fileName)}`);
              if (!response.ok) return null;
              const blob = await response.blob();
              return { fileName: attachment.fileName, contentType: blob.type || attachment.contentType || "application/octet-stream", blob };
            } catch { return null; }
          }));
          const cachedByName = new Map(attachmentBlobs.filter(Boolean).map((item) => [resourceFileKey(item.fileName), item.blob]));
          const externalQuestions = (publishedForm.questions || []).filter((question) => (
            question.type === "select_one_from_file" || question.type === "select_multiple_from_file"
          ));
          for (const question of externalQuestions) {
            const fileName = String(question.listName || "").trim();
            const blob = cachedByName.get(resourceFileKey(fileName));
            if (blob) externalChoiceData[question.name] = parseCsvRows(await blob.text());
          }
          const savedPackage = {
            accessCode: normalizeAccessCodeInput(accessCode),
            title: publishedForm.title || data.title || "ICPH Form",
            formId: publishedForm.formId || data.formId || "",
            draft,
            form: publishedForm,
            xml,
            externalChoices: externalChoiceData,
            attachments: attachmentBlobs.filter(Boolean),
            cachedAt: Date.now()
          };
          try {
            await saveOfflineFormPackage(savedPackage);
            await offlineCryptoKey();
            packageCached = true;
          } catch {}
          cachedPackageRef.current = savedPackage;
        } catch (networkError) {
          if (networkError.status && networkError.status < 500) throw networkError;
          const savedPackage = accessCode ? await loadOfflineFormPackage(accessCode) : null;
          if (!savedPackage) {
            if (!navigator.onLine) throw new Error("This form is not saved on this device yet. Open it once while online to make it available offline.");
            throw networkError;
          }
          try {
            await offlineCryptoKey();
          } catch {
            throw new Error("Encrypted offline storage is unavailable on this device.");
          }
          loadedOffline = true;
          packageCached = true;
          cachedPackageRef.current = savedPackage;
          data = { draft: savedPackage.draft, hasXml: Boolean(savedPackage.xml), title: savedPackage.title };
          draft = normalizeFormDraft(savedPackage.draft);
          publishedForm = savedPackage.form || (savedPackage.xml ? parseXFormXml(savedPackage.xml, draft) : draft);
          xml = savedPackage.xml || "";
          attachmentBlobs = savedPackage.attachments || [];
          externalChoiceData = savedPackage.externalChoices || {};
        }
        setFormXml(xml);
        setForm(publishedForm);
        setExternalChoices(externalChoiceData);
        const attachmentUrls = {};
        for (const attachment of attachmentBlobs) {
          if (attachment?.blob) attachmentUrls[resourceFileKey(attachment.fileName)] = URL.createObjectURL(attachment.blob);
        }
        setCachedAttachmentUrls(attachmentUrls);
        setOfflineReady(Boolean(accessCode && packageCached));
        const defaults = {};
        for (const question of publishedForm.questions || []) {
          if (question.defaultValue && question.defaultValue !== "now()") defaults[question.name] = question.defaultValue;
          if (question.defaultValue === "now()" && question.type === "dateTime") {
            defaults[question.name] = new Date().toISOString().slice(0, 16);
          }
          if (question.type === "today" && !defaults[question.name]) defaults[question.name] = todayString();
          if (question.type === "start" && !defaults[question.name]) defaults[question.name] = localTimestamp();
          if (question.type === "deviceid" && !defaults[question.name]) {
            const storageKey = "icph_device_id";
            try {
              const existing = window.localStorage.getItem(storageKey) || crypto.randomUUID();
              window.localStorage.setItem(storageKey, existing);
              defaults[question.name] = existing;
            } catch {
              defaults[question.name] = "browser-device";
            }
          }
        }
        const resumedAnswers = checkpointAnswers && typeof checkpointAnswers === "object" ? checkpointAnswers : {};
        let interruptedAnswers = {};
        if (!entryId && !Object.keys(resumedAnswers).length && accessCode) {
          try {
            const drafts = await readEncryptedOfflineRecords("offlineDrafts");
            const saved = drafts.find((item) => item.id === offlineDraftId(accessCode, workspaceId, entryId));
            interruptedAnswers = saved?.answers || {};
            setLocalDraftSaved(Object.keys(interruptedAnswers).length > 0);
          } catch {}
        }
        let entryAnswers = {};
        let entryToEdit = null;
        if (entryId) {
          const entriesData = await requestJson(`${formApiBase}/entries`);
          entryToEdit = (entriesData.entries || []).find((item) => String(item.id || "") === String(entryId));
          if (!entryToEdit) throw new Error("Entry not found.");
          entryAnswers = entryToEdit.answers && typeof entryToEdit.answers === "object" ? entryToEdit.answers : {};
        }
        const primaryIdentifierVariable = publishedForm.participantIdentifierVariable
          || publishedForm.primaryIdentifierVariable
          || draft.participantIdentifierVariable
          || draft.primaryIdentifierVariable
          || "";
        const seededAnswers = normalizeStoredRepeatAnswers(publishedForm, {
          ...defaults,
          ...resumedAnswers,
          ...interruptedAnswers,
          ...entryAnswers
        });
        if (primaryIdentifierVariable && resumePrimaryIdentifierValue) {
          seededAnswers[primaryIdentifierVariable] = resumePrimaryIdentifierValue;
        }
        setEditingEntry(entryToEdit);
        setAnswers(seededAnswers);
        setAnswersReady(true);
        const startLocationQuestion = publishedForm.questions?.find((question) => question.type === "start-geopoint");
        if (startLocationQuestion && navigator.geolocation && !seededAnswers[startLocationQuestion.name]) {
          navigator.geolocation.getCurrentPosition((position) => {
            const coords = position.coords;
            setAnswers((current) => ({
              ...current,
              [startLocationQuestion.name]: [coords.latitude, coords.longitude, coords.altitude || 0, coords.accuracy || ""].join(" ")
            }));
          }, () => {});
        }
        setSubmissionSuccess(false);
        setStatus(packageCached
          ? { kind: "ok", message: loadedOffline ? "Offline form ready." : entryToEdit ? "Editing submitted entry." : checkpointAnswers ? "Loaded saved checkpoint." : "Ready" }
          : { kind: "error", message: "Loaded online, but this device could not save an offline copy." });
      } catch (error) {
        setStatus({ kind: "error", message: error.message || String(error) });
      }
    }
    loadPublishedForm();
  }, [accessCode, checkpointAnswers, entryId, formApiBase, resumePrimaryIdentifierValue, workspaceId]);

  function setAnswer(name, value) {
    setSubmissionSuccess(false);
    setAnswers((current) => ({ ...current, [name]: value }));
  }

  async function retryPendingSync() {
    const result = await syncPendingSubmissions();
    setPendingSyncCount(result.pendingCount);
    const failedMessage = Object.values(result.errors)[0];
    setStatus(failedMessage
      ? { kind: "error", message: `Some saved responses need attention: ${failedMessage}` }
      : { kind: "ok", message: result.pendingCount ? `${result.pendingCount} item${result.pendingCount === 1 ? "" : "s"} still waiting to sync.` : "All saved responses are synced." });
  }

  function advanceGroupPage() {
    if (!canAdvanceGroup) {
      setStatus({ kind: "error", message: pageValidation.errors[0] || "Complete this section before continuing." });
      return;
    }
    setStatus({ kind: "ok", message: "Ready" });
    setActiveGroupPage((current) => Math.min(current + 1, groupPages.length - 1));
  }

  function goBackGroupPage() {
    setStatus({ kind: "ok", message: "Ready" });
    setActiveGroupPage((current) => Math.max(current - 1, 0));
  }

  async function submitEntry() {
    setStatus({ kind: "busy", message: "Saving local entry..." });
    try {
      const validation = validateAnswers(form, answers);
      if (validation.errors.length) {
        setStatus({ kind: "error", message: validation.errors[0] });
        return;
      }
      const visibleNames = new Set(visibleQuestions(form, validation.answers).map(questionAnswerKey));
      const submissionAnswers = {};
      for (const [name, value] of Object.entries(validation.answers)) {
        if (visibleNames.has(name)) submissionAnswers[name] = value;
      }
      const submissionPayload = {
        entryId: editingEntry?.id || entryId || "",
        answers: submissionAnswers
      };
      let result;
      if (accessCode) {
        result = await saveOfflineFirst(`${formApiBase}/entries`, submissionPayload);
      } else {
        await postJson(`${formApiBase}/entries`, submissionPayload);
        result = { queued: false, pendingCount: 0 };
      }
      notifyCollectionChanged();
      setPendingSyncCount(result.pendingCount);
      setStatus(result.error
        ? { kind: "error", message: `Saved on this device; sync needs attention: ${result.error}` }
        : result.queued
          ? { kind: "ok", message: "Saved on this device. It will sync when the connection is available." }
          : { kind: "ok", message: "Submitted and synced." });
      setSubmissionSuccess(true);
      setLocalDraftSaved(false);
      if (!editingEntry && !entryId) setAnswers({});
    } catch (error) {
      setStatus({ kind: "error", message: error.message || String(error) });
    }
  }

  async function saveCheckpoint() {
    if (!accessCode) {
      setStatus({ kind: "error", message: "Open the form from the respondent page to save a checkpoint." });
      return;
    }
    const primaryIdentifierVariable = String(form?.participantIdentifierVariable || form?.primaryIdentifierVariable || "").trim();
    if (!primaryIdentifierVariable) {
      setStatus({ kind: "error", message: "This form does not have a primary identifier variable." });
      return;
    }
    const checkpointIdentifierValue = String(calculatedAnswers[primaryIdentifierVariable] || answers[primaryIdentifierVariable] || "").trim();
    if (!checkpointIdentifierValue) {
      setStatus({ kind: "error", message: `Fill ${primaryIdentifierQuestionText(form)} before saving a checkpoint.` });
      return;
    }
    setStatus({ kind: "busy", message: "Saving checkpoint..." });
    try {
      const visibleNames = new Set(visibleQuestions(form, calculatedAnswers).map(questionAnswerKey));
      const checkpointData = {};
      for (const [name, value] of Object.entries(calculatedAnswers)) {
        if (visibleNames.has(name) || name === primaryIdentifierVariable) checkpointData[name] = value;
      }
      const result = await saveOfflineFirst(`${formApiBase}/checkpoint`, {
        primaryIdentifierValue: checkpointIdentifierValue,
        answers: checkpointData
      });
      notifyCollectionChanged();
      setPendingSyncCount(result.pendingCount);
      setStatus(result.error
        ? { kind: "error", message: `Checkpoint saved on this device; sync needs attention: ${result.error}` }
        : result.queued
          ? { kind: "ok", message: "Checkpoint saved on this device. It will sync when the connection is available." }
          : { kind: "ok", message: "Checkpoint saved and synced." });
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
    <div className={`fill-shell ${useOdkViewer ? "odk-fill-shell" : ""}`}>
      <header className={`fill-header ${useOdkViewer ? "odk-view-header" : ""}`}>
        {!useOdkViewer ? (
          <div>
            <h1>{form.title}</h1>
            <p>{editingEntry ? "Editing submitted entry" : accessCode ? `Respondent code ${normalizeAccessCodeInput(accessCode)}` : form.formId}</p>
          </div>
        ) : <span className="odk-view-context">ICPH Form</span>}
        <div className="fill-header-actions">
          {secondaryLanguage && !useOdkViewer ? (
            <div className="language-switcher">
              <button className={languageMode === "default" ? "active" : ""} type="button" onClick={() => setLanguageMode("default")}>English</button>
              <button className={languageMode === "secondary" ? "active" : ""} type="button" onClick={() => setLanguageMode("secondary")}>{secondaryLanguage}</button>
            </div>
          ) : null}
          {onBackToRespondent ? (
            <button className="secondary small" onClick={onBackToRespondent}>
              <ChevronRight size={16} /> Change Code
            </button>
          ) : null}
          <div className={`status-line ${status.kind}`}>
            {status.kind === "ok" ? <Check size={16} /> : <AlertCircle size={16} />}
            <span>{status.message}</span>
          </div>
          {accessCode ? (
            <div className={`offline-sync-indicator ${isOnline ? "online" : "offline"}`} aria-live="polite">
              <span>{isOnline ? "Online" : "Offline"}</span>
              {pendingSyncCount ? <span>{pendingSyncCount} item{pendingSyncCount === 1 ? "" : "s"} waiting to sync</span> : null}
              {offlineReady ? <span>Form saved on this device</span> : null}
              {localDraftSaved ? <span>Draft saved on this device</span> : null}
              {pendingSyncCount && isOnline ? <button className="secondary small" type="button" onClick={retryPendingSync}><RefreshCw size={14} /> Sync now</button> : null}
            </div>
          ) : null}
        </div>
	      </header>
	      <main className={`fill-card ${useOdkViewer ? "odk-fill-card" : ""}`}>
	        {!useOdkViewer && hasGroupSections ? (
	          <div className="group-page-progress" aria-label="Form sections">
	            <span>Section {Math.min(activeGroupPage + 1, groupPages.length)} of {groupPages.length}</span>
	            <div className="group-page-progress-bar" aria-hidden="true">
	              <span style={{ width: `${groupPages.length ? ((activeGroupPage + 1) / groupPages.length) * 100 : 0}%` }} />
	            </div>
	          </div>
	        ) : null}
	        {useOdkViewer ? (
	          <OdkWebFormIsland
	            form={form}
	            formXml={formXml}
            workspaceId={workspaceId}
            formApiBase={formApiBase}
            offlineCapable={Boolean(accessCode)}
            cachedAttachmentUrls={cachedAttachmentUrls}
            onSubmitted={(result) => {
              notifyCollectionChanged();
              setPendingSyncCount(result?.pendingCount ?? pendingSyncCount);
              setStatus(result?.error
                ? { kind: "error", message: `Saved on this device; sync needs attention: ${result.error}` }
                : result?.queued
                  ? { kind: "ok", message: "Saved on this device. It will sync when the connection is available." }
                  : { kind: "ok", message: "Submitted and synced." });
              setSubmissionSuccess(true);
            }}
	            onError={(error) => setStatus({ kind: "error", message: error?.message || String(error) })}
	          />
	        ) : pageQuestions.map((question, index) => {
            const answerKey = questionAnswerKey(question);
            const previousQuestion = pageQuestions[index - 1];
            const startsRepeat = question.repeatIndex && question.repeatIndex !== previousQuestion?.repeatIndex;
            return (
              <React.Fragment key={question.id}>
                {startsRepeat ? <div className="repeat-instance-heading">{question.repeatLabel || "Repeat"} {question.repeatIndex}</div> : null}
                <PreviewField
                  question={question}
                  value={calculatedAnswers[answerKey] || ""}
                  onChange={(value) => setAnswer(answerKey, value)}
                  languageMode={languageMode}
                  choiceOptions={externalChoices[question.name] || []}
                  workspaceId={workspaceId}
                  accessCode={accessCode}
                  cachedAttachments={cachedAttachmentUrls}
                />
              </React.Fragment>
            );
        })}
	        {submissionSuccess ? (
	          <div className="submission-success-inline">
	            <Check size={16} /> {editingEntry ? "Updated!" : "Submitted!"}
	          </div>
	        ) : null}
	      </main>
	      {!useOdkViewer ? <footer className="respondent-footer">
	        <div className={`footer-status ${status.kind}`}>
	          {status.kind === "ok" ? <Check size={16} /> : <AlertCircle size={16} />}
	          <span>{status.message || (hasGroupSections && !isLastGroupPage ? (canAdvanceGroup ? "Ready to continue." : pageValidation.errors[0] || "Complete this section.") : (canSubmit ? "Ready to submit." : answerValidation.errors[0] || "Ready"))}</span>
	        </div>
	        <div className="footer-actions">
	          <button className="secondary" disabled={!form || status.kind === "busy"} onClick={saveCheckpoint}>
	            <Save size={16} /> Save Checkpoint
	          </button>
	          {hasGroupSections && activeGroupPage > 0 ? (
            <button className="secondary group-page-back" disabled={status.kind === "busy"} onClick={goBackGroupPage}>
              <ChevronRight size={16} /> Back
            </button>
          ) : null}
          {hasGroupSections && !isLastGroupPage ? (
            <button className="primary" disabled={!canAdvanceGroup} onClick={advanceGroupPage}>
              Next <ChevronRight size={16} />
            </button>
          ) : (
            <button className="primary" disabled={!canSubmit} onClick={submitEntry}>
              <Check size={16} /> {editingEntry ? "Update" : "Submit"}
            </button>
          )}
	        </div>
	      </footer> : null}
    </div>
  );
}

function EntryViewer({ workspaceId, entryId }) {
  const [form, setForm] = useState(null);
  const [entry, setEntry] = useState(null);
  const [status, setStatus] = useState({ kind: "busy", message: "Loading entry..." });
  const answers = form && entry ? computeCalculatedAnswers(form, normalizeStoredRepeatAnswers(form, entry.answers || {})) : {};
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
            value={answers[questionAnswerKey(question)] || ""}
            forceDisabled
            workspaceId={workspaceId}
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
