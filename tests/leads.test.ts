import { describe, expect, it } from "vitest";
import type { Row } from "../src/client.js";
import {
  EXPORT_COLUMNS,
  annotateContacts,
  annotateRepeats,
  exportDate,
  isLead,
  localStamp,
  markRecovered,
  personKey,
  phoneKey,
  stageLabel,
  summarize,
  toContact,
  toLead,
  toLeadRow,
  type Lead,
} from "../src/leads.js";

function session(over: Row = {}): Row {
  return {
    id: "s1",
    session_created_at: "2026-09-10 14:05:33",
    status: "abandoned",
    last_step: "schedule",
    customer_name: "Pat Example",
    customer_phone_number: "",
    street_address: "",
    city: "",
    state: "",
    zip_code: "",
    job_type: "AC Repair",
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "fall",
    booked_job_id: "",
    ...over,
  };
}

describe("inclusion rule", () => {
  it("keeps sessions with a phone or a street address, and nothing else", () => {
    expect(isLead(session({ customer_phone_number: "5555550100" }))).toBe(true);
    expect(isLead(session({ street_address: "1 Main St" }))).toBe(true);
    expect(isLead(session())).toBe(false);
    expect(isLead(session({ customer_phone_number: "  ", street_address: "" }))).toBe(false);
    expect(isLead(session({ status: "completed", last_step: "booked", customer_name: "", customer_phone_number: "" }))).toBe(false);
  });
});

describe("column mapping", () => {
  it("builds the export's columns in order, then the extras", () => {
    const row = toLeadRow(session({ customer_phone_number: "952-250-7473", street_address: "1 Main St", zip_code: "80202" }), "blue");
    expect(Object.keys(row).slice(0, EXPORT_COLUMNS.length)).toEqual([...EXPORT_COLUMNS]);
    expect(row).toMatchObject({
      Tenant: "Blue Sky",
      Date: "09/10/2026 14:05",
      Name: "Pat Example",
      "Identified By": "Phone",
      "Phone Number": "952-250-7473",
      Booked: "No",
      "Furthest Stage Reached": "Schedule (stage 4 of 6)",
      Service: "AC Repair",
      "UTM Source": "google",
      stage_number: 4,
      session_id: "s1",
      person_key: "phone:9522507473",
    });
    expect(toLeadRow(session({ street_address: "1 Main St" }), "stl")["Identified By"]).toBe("Address");
    expect(toLeadRow(session({ status: "completed", last_step: "booked", customer_phone_number: "1" }), "nope")).toMatchObject({ Tenant: "nope", Booked: "Yes" });
  });

  it("labels stages, including location and blank", () => {
    expect(stageLabel("customer")).toBe("Customer (stage 3 of 6)");
    expect(stageLabel("booked")).toBe("Booked (stage 6 of 6)");
    expect(stageLabel("location")).toBe("Location");
    expect(stageLabel("")).toBe("");
  });

  it("converts dates between the session, interaction, and export formats", () => {
    expect(exportDate("2026-09-01 07:03:09")).toBe("09/01/2026 07:03");
    expect(localStamp("09/01/2026 07:03")).toBe("2026-09-01 07:03");
    expect(localStamp("2026-09-01 07:03:09")).toBe("2026-09-01 07:03");
  });
});

describe("person keys", () => {
  it("treats dashed, plus-one, and bare phones as one person", () => {
    expect(phoneKey("952-250-7473")).toBe("9522507473");
    expect(phoneKey("+19522507473")).toBe("9522507473");
    expect(phoneKey("(952) 250-7473")).toBe("9522507473");
    expect(phoneKey("12345")).toBeUndefined();
  });

  it("falls back to a normalized address plus zip", () => {
    const a = personKey(session({ street_address: "1 Main St.", zip_code: "80202-1234" }));
    const b = personKey(session({ street_address: " 1  MAIN st", zip_code: "80202" }));
    expect(a).toBe("address:1 main st 80202");
    expect(b).toBe(a);
  });
});

const lead = (over: Row): Lead => toLead(session({ customer_phone_number: "5555550100", ...over }), "blue");

describe("repeats and follow-ups", () => {
  it("numbers attempts and marks booked_later only for a later completed session", () => {
    const first = lead({ id: "a", session_created_at: "2026-09-10 08:00:00" });
    const booked = lead({ id: "b", session_created_at: "2026-09-10 09:00:00", status: "completed", last_step: "booked", booked_job_id: "J9" });
    const after = lead({ id: "c", session_created_at: "2026-09-10 10:00:00" });
    const other = lead({ id: "d", customer_phone_number: "3145550111" });
    const all = [after, booked, first, other];
    annotateRepeats(all, all, 7);
    expect(first.row).toMatchObject({ attempt: 1, sessions_for_person: 3, booked_later: "Yes", booked_later_at: "09/10/2026 09:00", booked_later_job_id: "J9" });
    expect(booked.row).toMatchObject({ attempt: 2, booked_later: "" });
    expect(after.row).toMatchObject({ attempt: 3, booked_later: "No" });
    expect(other.row).toMatchObject({ attempt: 1, sessions_for_person: 1, booked_later: "No" });
  });

  it("counts earlier sessions outside the returned set", () => {
    const earlier = lead({ id: "x", session_created_at: "2026-09-01 08:00:00" });
    const now = lead({ id: "y" });
    annotateRepeats([now], [earlier, now], 7);
    expect(now.row).toMatchObject({ attempt: 2, sessions_for_person: 2 });
  });

  it("picks the first contact at or after the session and ignores earlier ones", () => {
    const l = lead({ session_created_at: "2026-09-10 14:05:33" });
    const contacts = [
      toContact({ phoneNumber: "+15555550100", date: "09/10/2026 13:00", category: "Booked", jobId: "early" }, "call"),
      toContact({ phoneNumber: "+15555550100", date: "09/11/2026 09:00", category: "Not Booked" }, "inbound_text"),
      toContact({ phoneNumber: "+15555550100", date: "09/10/2026 14:05", category: "Transferred", jobId: null, postTransferJobId: "PT1" }, "call"),
    ].filter((c) => c !== undefined);
    annotateContacts([l], contacts, 7);
    expect(l.row).toMatchObject({
      contacted_later: "Yes",
      contacted_later_at: "09/10/2026 14:05",
      contacted_later_via: "Call",
      contacted_later_category: "Transferred",
      contacted_later_job_id: "PT1",
    });
  });

  it("ignores rebookings and contacts after the follow-up window", () => {
    const l = lead({ id: "w", session_created_at: "2026-09-10 14:05:33" });
    const late = lead({ id: "v", session_created_at: "2026-09-17 14:06:00", status: "completed" });
    const edge = toContact({ phoneNumber: "5555550100", date: "09/17/2026 14:05", category: "Handled" }, "call");
    annotateRepeats([l], [l, late], 7);
    annotateContacts([l], [edge!], 7);
    expect(l.row).toMatchObject({ booked_later: "No", contacted_later: "Yes", contacted_later_category: "Handled" });
    annotateContacts([l], [edge!], 6);
    expect(l.row.contacted_later).toBe("No");
  });

  it("marks recovered from a rebooking or a contact with a job or Booked category", () => {
    const rebooked = lead({ id: "1" });
    rebooked.row.booked_later = "Yes";
    const called = lead({ id: "2" });
    Object.assign(called.row, { booked_later: "No", contacted_later: "Yes", contacted_later_category: "Booked" });
    const chatted = lead({ id: "3" });
    Object.assign(chatted.row, { booked_later: "No", contacted_later: "Yes", contacted_later_category: "Not Booked" });
    const booked = lead({ id: "4", status: "completed" });
    markRecovered([rebooked, called, chatted, booked]);
    expect([rebooked, called, chatted, booked].map((l) => l.row.recovered)).toEqual(["Yes", "Yes", "No", ""]);
  });
});

describe("summary", () => {
  it("counts booked, abandoned, recovered, and breakdowns of the abandoned", () => {
    const rows: Row[] = [
      { Booked: "Yes", Service: "AC Repair" },
      { Booked: "No", recovered: "Yes", Service: "AC Repair", "Furthest Stage Reached": "Schedule (stage 4 of 6)" },
      { Booked: "No", recovered: "No", Service: "Drain", "Furthest Stage Reached": "Schedule (stage 4 of 6)" },
      { Booked: "No", recovered: "No", Service: "", "Furthest Stage Reached": "Customer (stage 3 of 6)" },
    ];
    const s = summarize(rows);
    expect(s).toMatchObject({ leads: 4, booked: 1, abandoned: 3, recovered: 1, stillBounced: 2 });
    expect(s.abandonedBy.furthestStage).toEqual([
      { value: "Schedule (stage 4 of 6)", count: 2 },
      { value: "Customer (stage 3 of 6)", count: 1 },
    ]);
    expect(s.abandonedBy.service).toContainEqual({ value: "(blank)", count: 1 });
  });
});
