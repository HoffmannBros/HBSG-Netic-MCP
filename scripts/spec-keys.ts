/**
 * Row keys each endpoint's schema declares in docs/vendor/netic-openapi.yaml,
 * by variant. The probe compares live rows against these. Keep in step with
 * the spec when Netic ships a new version.
 */
export const INTERACTION_KEYS = [
  "id", "updatedAt", "postTransferUpdatedAt", "tenant", "phoneNumber", "date", "leadStatus", "category", "reason",
  "subReason", "trade", "workType", "triagedJobType", "serviceTitanCallId", "serviceTitanCampaignId",
  "serviceTitanCampaignName", "modality", "leadSource", "gclid", "msclkid", "utmSource", "utmMedium", "utmCampaign",
  "utmContent", "utmTerm", "utmId",
];

export const TGL_SERVICETITAN_KEYS = [
  "booked_at", "job_id", "job_type_name", "booked_by_technician_id", "technician_name", "source_business_unit",
  "booked_business_unit", "arrival_window_start", "id", "updated_at",
];

export const TGL_CARGAS_KEYS = [
  "date", "outcome_type", "account_number", "source_job_id", "source_service_code", "technician_name", "service_type",
  "appointment_date", "advisor_name", "note_text", "booked_job_id", "id", "updated_at",
];

export const SCHEDULER_BOOKING_SERVICETITAN_KEYS = [
  "session_created_at", "session_status", "session_source", "customer_phone_number", "service_titan_job_id",
  "service_titan_tenant_id", "job_type_id", "workflow", "marketing_campaign_id", "location_id", "booked_job_created_at",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "msclkid",
  "landing_page_url", "referrer_url", "id", "updated_at",
];

export const SCHEDULER_BOOKING_SESSION_KEYS = [
  "session_created_at", "session_status", "session_source", "outcome_type", "booked_job_id", "appointment_date",
  "advisor_name", "customer_name", "customer_phone_number", "customer_type", "street_address", "city", "state",
  "zip_code", "customer_id", "location_id", "trade", "work_type", "workflow", "job_type", "job_details", "utm_source",
  "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "msclkid", "landing_page_url",
  "referrer_url", "id", "updated_at",
];

/** Sessions are `additionalProperties: string`; these are the keys the description names. */
export const SCHEDULER_SESSION_KEYS = [
  "status", "last_step", "booked_from", "blocker_type", "blocker_detail", "booked_job_id", "se_campaign", "utm_source",
  "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "gbraid", "wbraid", "fbclid", "msclkid",
  "landing_page_url", "referrer_url", "marketing_source", "customer_is_new", "location_is_new", "issue_description",
  "appointment_start", "appointment_end",
];

export const REFERRER_KEYS = ["referrer_email", "booked_at", "st_job_id", "job_type", "customer_name", "appointment_date", "status", "id", "updated_at"];

export const OUTBOUND_KEYS = [
  "id", "service_titan_call_id", "job_id", "tenant", "call_placed_at", "call_duration_seconds", "agent_id", "agent_name",
  "customer_phone", "call_type", "call_reason", "summary", "transcript", "analysis",
];

/**
 * Utilization is not in the vendor spec. These are the row keys seen live on
 * all four tenants on 2026-09-25, from Netic's own 400 hint and responses.
 */
export const UTILIZATION_KEYS = [
  "date", "type", "name", "businessUnitId", "groups", "percentBooked", "jobHours", "shiftHours", "nonJobHours",
  "availableHours", "jobs",
];
