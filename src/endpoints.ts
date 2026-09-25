/** The report endpoints: six in docs/vendor/netic-openapi.yaml, plus utilization. All are GET. */

export const PATH_PREFIX = "/api/public/metrics/";

export const MODALITIES = ["call", "inbound_text", "recapture_text"] as const;
export type Modality = (typeof MODALITIES)[number];

export const REPORTS = [
  "interactions",
  "scheduler_sessions",
  "scheduler_bookings",
  "tgl_bookings",
  "referrer_bookings",
  "outbound_calls",
  "utilization",
] as const;
export type Report = (typeof REPORTS)[number];

export interface DateParams {
  start: string;
  end: string;
}

/** The six spec endpoints filter on creation date. */
export const CREATED_DATE_PARAMS: DateParams = { start: "createdOnOrAfter", end: "createdBefore" };

export interface ReportInfo {
  path: string;
  label: string;
  /** The API's names for the inclusive start and end dates. */
  dateParams: DateParams;
  /** Longest inclusive range one request may span; longer ranges are split. */
  maxRangeDays?: number;
  /** Identity of a row, for dropping duplicates when a range is split. */
  rowKey?: (row: Record<string, unknown>) => string;
  /**
   * Columns worth showing inline when the caller names none. Union across the
   * provider-specific row shapes; only the ones present in the rows are used.
   */
  defaultColumns: string[];
}

export const REPORT_INFO: Record<Report, ReportInfo> = {
  interactions: {
    path: "/api/public/metrics/interactions",
    label: "inbound interactions",
    dateParams: CREATED_DATE_PARAMS,
    defaultColumns: [
      "date",
      "phoneNumber",
      "modality",
      "category",
      "reason",
      "subReason",
      "trade",
      "workType",
      "triagedJobType",
      "leadSource",
      "serviceTitanCampaignName",
      "postTransferOutcome",
      "jobId",
      "callDurationTotal",
    ],
  },
  scheduler_sessions: {
    path: "/api/public/metrics/scheduler/sessions",
    label: "online scheduler sessions",
    dateParams: CREATED_DATE_PARAMS,
    defaultColumns: [
      "session_created_at",
      "status",
      "last_step",
      "session_source",
      "booked_from",
      "device_type",
      "blocker_type",
      "blocker_detail",
      "booked_job_id",
      "trade",
      "job_type",
      "marketing_source",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "customer_is_new",
    ],
  },
  scheduler_bookings: {
    path: "/api/public/metrics/bookings/scheduler",
    label: "online scheduler bookings",
    dateParams: CREATED_DATE_PARAMS,
    defaultColumns: [
      "session_created_at",
      "booked_job_created_at",
      "session_status",
      "session_source",
      "service_titan_job_id",
      "booked_job_id",
      "job_type_id",
      "job_type",
      "trade",
      "workflow",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "landing_page_url",
    ],
  },
  tgl_bookings: {
    path: "/api/public/metrics/bookings/technician-tgl",
    label: "technician TGL bookings",
    dateParams: CREATED_DATE_PARAMS,
    defaultColumns: [
      "booked_at",
      "date",
      "job_id",
      "booked_job_id",
      "job_type_name",
      "service_type",
      "outcome_type",
      "technician_name",
      "source_business_unit",
      "booked_business_unit",
      "arrival_window_start",
      "appointment_date",
    ],
  },
  referrer_bookings: {
    path: "/api/public/metrics/bookings/referrer",
    label: "referrer (RGL) bookings",
    dateParams: CREATED_DATE_PARAMS,
    defaultColumns: ["booked_at", "referrer_email", "st_job_id", "job_type", "customer_name", "appointment_date", "status"],
  },
  outbound_calls: {
    path: "/api/public/metrics/calls/outbound",
    label: "outbound CSR calls",
    dateParams: CREATED_DATE_PARAMS,
    defaultColumns: [
      "call_placed_at",
      "agent_name",
      "agent_id",
      "call_type",
      "call_reason",
      "call_duration_seconds",
      "job_id",
      "service_titan_call_id",
      "summary",
    ],
  },
  utilization: {
    path: "/api/public/metrics/utilization",
    label: "utilization board rows",
    dateParams: { start: "startDate", end: "endDate" },
    // Live 2026-09-25: 31 inclusive days is accepted, 32 is a 400.
    maxRangeDays: 31,
    rowKey: (r) => [r.date, r.type, r.name, r.businessUnitId].map((v) => String(v ?? "")).join("|"),
    defaultColumns: [
      "date",
      "type",
      "name",
      "board",
      "percentBooked",
      "jobs",
      "jobHours",
      "availableHours",
      "shiftHours",
      "nonJobHours",
      "groups",
      "businessUnitId",
    ],
  },
};

export const UTILIZATION_PATH = REPORT_INFO.utilization.path;

/** Per-row hour and job fields on utilization, which sum across days. */
export const UTILIZATION_SUM_FIELDS = ["jobs", "jobHours", "shiftHours", "nonJobHours", "availableHours"] as const;

/** Large text columns on outbound calls, dropped unless asked for. */
export const TRANSCRIPT_COLUMNS = ["transcript", "analysis"] as const;
