/** The flow demo, run against the trace demo's gateway: list the rides, pick
 *  the open ones, write them all to a sheet, book the open one (which fails:
 *  `payments` isn't on the network), then the step after it is skipped. */
import { kv } from "../collections/model";
import { newStep, type Flow, type FlowsDoc, type RequestStep, type SheetStep, type TransformStep } from "./model";

export const DEMO_FLOW_ID = "flow-demo";

export function demoFlow(port: number): Flow {
  const call = (id: string, name: string, patch: Partial<RequestStep>): RequestStep => ({
    ...(newStep("request") as RequestStep),
    id: `${DEMO_FLOW_ID}-${id}`,
    name,
    ...patch,
  });
  const pick: TransformStep = {
    ...(newStep("transform") as TransformStep),
    id: `${DEMO_FLOW_ID}-open`,
    name: "Pick the open rides",
    as: "open",
    code: [
      'const open = _.filter(rides, { status: "open" });',
      "log(`${open.length} of ${rides.length} rides are open`);",
      "return open;",
    ].join("\n"),
  };
  const sheet: SheetStep = {
    ...(newStep("sheet") as SheetStep),
    id: `${DEMO_FLOW_ID}-sheet`,
    name: "Rides sheet",
    from: "rides",
    columns: [kv("Ride", "id"), kv("From", "from"), kv("To", "to"), kv("Status", "status")],
    file: "~/Documents/UAT/rides-{{rider.name}}.xlsx",
  };
  return {
    id: DEMO_FLOW_ID,
    name: "Book an open ride",
    vars: [kv("base", `http://localhost:${port}`)],
    steps: [
      call("list", "List rides", { url: "{{base}}/rides", keep: [kv("rides", "body.rides"), kv("rider", "body.rider")] }),
      pick,
      sheet,
      call("book", "Book the open ride", {
        method: "POST",
        url: "{{base}}/rides",
        bodyType: "json",
        body: '{\n  "rider": "{{rider.id}}",\n  "from": "{{open[0].from}}",\n  "to": "{{open[0].to}}"\n}',
        keep: [kv("booking", "body.id")],
      }),
      call("rider", "Get the rider", { url: "{{base}}/users/{{rider.id}}", keep: [kv("profile", "body")] }),
    ],
  };
}

/** The demo flow pointed at the gateway's port now; edits kept. */
export function repointFlow(flow: Flow, port: number): Flow {
  return {
    ...flow,
    vars: flow.vars.map((v) =>
      v.key === "base" ? { ...v, value: v.value.replace(/\/\/localhost:\d+/, `//localhost:${port}`) } : v,
    ),
  };
}

/** `doc` with the demo flow, pointed at `port`: added first, or updated where it is */
export function withDemoFlow(doc: FlowsDoc, port: number): FlowsDoc {
  const there = doc.flows.some((f) => f.id === DEMO_FLOW_ID);
  return {
    ...doc,
    flows: there ? doc.flows.map((f) => (f.id === DEMO_FLOW_ID ? repointFlow(f, port) : f)) : [demoFlow(port), ...doc.flows],
  };
}
