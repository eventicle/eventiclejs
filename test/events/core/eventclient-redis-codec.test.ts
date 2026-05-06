import {
  buildStreamEntryFields,
  parseStreamEntry,
} from "../../../src/events/core/eventclient-redis";
import { EncodedEvent } from "../../../src/events/core/event-client";

function createEncodedEvent(overrides: Partial<EncodedEvent> = {}): EncodedEvent {
  return {
    buffer: Buffer.from(JSON.stringify({ type: "test-event", data: { value: 42 } })),
    key: "domain-123",
    timestamp: 1709942400000,
    headers: { type: "test-event", id: "evt-1", source: "unit-test" },
    ...overrides,
  };
}

describe("buildStreamEntryFields and parseStreamEntry round-trip", () => {
  test("round-trips a standard encoded event", () => {
    const original = createEncodedEvent();
    const fields = buildStreamEntryFields(original);
    const parsed = parseStreamEntry(fields);

    expect(parsed.buffer).toEqual(original.buffer);
    expect(parsed.key).toEqual(original.key);
    expect(parsed.timestamp).toEqual(original.timestamp);
    expect(parsed.headers).toEqual(original.headers);
  });

  test("preserves binary buffer content through base64 encoding", () => {
    const binaryContent = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f]);
    const original = createEncodedEvent({ buffer: binaryContent });
    const fields = buildStreamEntryFields(original);
    const parsed = parseStreamEntry(fields);

    expect(parsed.buffer).toEqual(binaryContent);
  });

  test("round-trips empty headers", () => {
    const original = createEncodedEvent({ headers: {} });
    const fields = buildStreamEntryFields(original);
    const parsed = parseStreamEntry(fields);

    expect(parsed.headers).toEqual({});
  });

  test("round-trips empty key", () => {
    const original = createEncodedEvent({ key: "" });
    const fields = buildStreamEntryFields(original);
    const parsed = parseStreamEntry(fields);

    expect(parsed.key).toEqual("");
  });

  test("round-trips undefined key as empty string", () => {
    const original = createEncodedEvent({ key: undefined });
    const fields = buildStreamEntryFields(original);
    const parsed = parseStreamEntry(fields);

    expect(parsed.key).toEqual("");
  });

  test("round-trips headers with nested objects", () => {
    const complexHeaders = {
      type: "order.created",
      metadata: { region: "eu-west-1", version: 3 },
      tags: ["priority", "batch"],
    };
    const original = createEncodedEvent({ headers: complexHeaders });
    const fields = buildStreamEntryFields(original);
    const parsed = parseStreamEntry(fields);

    expect(parsed.headers).toEqual(complexHeaders);
  });

  test("round-trips zero timestamp", () => {
    const original = createEncodedEvent({ timestamp: 0 });
    const fields = buildStreamEntryFields(original);
    const parsed = parseStreamEntry(fields);

    expect(parsed.timestamp).toEqual(0);
  });

  test("round-trips large timestamp", () => {
    const largeTimestamp = 9999999999999;
    const original = createEncodedEvent({ timestamp: largeTimestamp });
    const fields = buildStreamEntryFields(original);
    const parsed = parseStreamEntry(fields);

    expect(parsed.timestamp).toEqual(largeTimestamp);
  });

  test("round-trips empty buffer", () => {
    const original = createEncodedEvent({ buffer: Buffer.alloc(0) });
    const fields = buildStreamEntryFields(original);
    const parsed = parseStreamEntry(fields);

    expect(parsed.buffer).toEqual(Buffer.alloc(0));
  });
});

describe("buildStreamEntryFields", () => {
  test("produces 8 field strings (4 key-value pairs)", () => {
    const fields = buildStreamEntryFields(createEncodedEvent());
    expect(fields.length).toEqual(8);
  });

  test("stores buffer as base64", () => {
    const original = createEncodedEvent();
    const fields = buildStreamEntryFields(original);
    const bufferIndex = fields.indexOf("buf") + 1;

    expect(fields[bufferIndex]).toEqual(original.buffer.toString("base64"));
  });

  test("stores timestamp as string", () => {
    const original = createEncodedEvent({ timestamp: 1709942400000 });
    const fields = buildStreamEntryFields(original);
    const tsIndex = fields.indexOf("ts") + 1;

    expect(fields[tsIndex]).toEqual("1709942400000");
  });

  test("stores headers as JSON string", () => {
    const headers = { type: "test", id: "1" };
    const original = createEncodedEvent({ headers });
    const fields = buildStreamEntryFields(original);
    const hdrsIndex = fields.indexOf("hdrs") + 1;

    expect(JSON.parse(fields[hdrsIndex])).toEqual(headers);
  });
});

describe("parseStreamEntry", () => {
  test("handles missing buffer field with empty buffer", () => {
    const fields = ["key", "some-key", "ts", "1000", "hdrs", "{}"];
    const parsed = parseStreamEntry(fields);

    expect(parsed.buffer).toEqual(Buffer.alloc(0));
  });

  test("handles missing key field with empty string", () => {
    const fields = ["buf", "", "ts", "1000", "hdrs", "{}"];
    const parsed = parseStreamEntry(fields);

    expect(parsed.key).toEqual("");
  });

  test("handles missing timestamp field with zero", () => {
    const fields = ["buf", "", "key", "k", "hdrs", "{}"];
    const parsed = parseStreamEntry(fields);

    expect(parsed.timestamp).toEqual(0);
  });

  test("handles missing headers field with empty object", () => {
    const fields = ["buf", "", "key", "k", "ts", "1000"];
    const parsed = parseStreamEntry(fields);

    expect(parsed.headers).toEqual({});
  });

  test("handles completely empty fields array", () => {
    const parsed = parseStreamEntry([]);

    expect(parsed.buffer).toEqual(Buffer.alloc(0));
    expect(parsed.key).toEqual("");
    expect(parsed.timestamp).toEqual(0);
    expect(parsed.headers).toEqual({});
  });
});
