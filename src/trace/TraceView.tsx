import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Box, Globe, Send, SquareTerminal, X } from "lucide-react";
import { Spinner } from "../ui";
import type { Entry, Hop, Origin, ServiceLines, Trace, TraceState } from "./api";
import "./trace.css";

type Ready = Extract<TraceState, { status: "ready" }>;

/** A call's trace: what it reached and what that called, then everything
 *  that happened in order, the services' own output included. */
export function TracePanel({ state, none }: { state: TraceState | undefined; none?: ReactNode }) {
  if (!state || state.status === "preparing" || state.status === "collecting") {
    return (
      <div className="trace trace--note">
        <Spinner />
        <span>{state?.status === "collecting" ? "Reading what it called…" : "Getting ready to follow the call…"}</span>
      </div>
    );
  }
  if (state.status === "none") {
    return (
      <div className="trace trace--note trace--none">
        <span>
          Calls to a service in UAT are traced: a <span className="mono">localhost</span> port that one of its
          containers publishes or one of its commands listens on.
        </span>
        {none}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="trace trace--note" data-tone="bad">
        <span>{state.error}</span>
      </div>
    );
  }
  return <TraceBody key={state.origin.at} {...state} />;
}

function TraceBody({ origin, entry, trace, logs }: Ready) {
  const [focus, setFocus] = useState<string | null>(null);
  const notes = useMemo(() => notesFor(entry, trace), [entry, trace]);
  return (
    <div className="trace">
      <CallTree
        origin={origin}
        entry={entry}
        trace={trace}
        focus={focus}
        onFocus={(name) => setFocus((f) => (f === name ? null : name))}
      />
      {notes.length > 0 && (
        <div className="trace__notes">
          {notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}
      <Timeline origin={origin} entry={entry} trace={trace} logs={logs} focus={focus} onClear={() => setFocus(null)} />
    </div>
  );
}

// ---- Call tree ----

type NodeKind = "you" | "container" | "process" | "external" | "failed";

type Tone = "ok" | "external" | "bad" | "wait";

/** One call in the tree: who was called, from the row it hangs under. */
type TRow = {
  key: string;
  depth: number;
  parent: number | null;
  name: string;
  port: number | null;
  kind: NodeKind;
  tone: Tone;
  label: string;
  status: string | null;
  at: number;
  ms: number | null;
  /** The service the row is about, for focusing the timeline */
  about: string | null;
};

const ROW = 30;
const INDENT = 34;
const PAD = 8;
/** Center of a row's mark, from the tree's left edge */
const markX = (depth: number) => 20 + depth * INDENT + 9;

function hopLabel(h: Hop): { label: string; status: string | null } {
  if (h.state !== "ok" && h.state !== "pending") return { label: h.error ?? h.state, status: null };
  const r = h.requests[0];
  if (r) {
    const more = h.requests.length > 1 ? `  +${h.requests.length - 1} more` : "";
    return {
      label: `${r.method} ${r.path}${more}`,
      status: r.status ? String(r.status) : r.error ? "✕" : null,
    };
  }
  if (h.state === "pending") return { label: "connecting…", status: null };
  return {
    label: h.count > 1 ? `${h.count} connections` : "connected",
    status: null,
  };
}

function buildRows(origin: Origin, entry: Entry, trace: Trace): TRow[] {
  const kinds = new Map(trace.nodes.map((n) => [n.name, n.kind]));
  const status = origin.outcome.match(/^\d{3}\b/)?.[0] ?? null;
  const rows: TRow[] = [
    {
      key: "you",
      depth: 0,
      parent: null,
      name: "You",
      port: null,
      kind: "you",
      tone: "ok",
      label: "",
      status: null,
      at: origin.at,
      ms: null,
      about: null,
    },
    {
      key: "entry",
      depth: 1,
      parent: 0,
      name: entry.service,
      port: null,
      kind: entry.kind,
      tone: origin.ok ? "ok" : "bad",
      label: origin.ok ? origin.label : `${origin.label}  ${origin.outcome}`,
      status: status ?? (origin.ok ? null : "✕"),
      at: origin.at,
      // A socket message has no answer to time
      ms: origin.end > origin.at ? origin.end - origin.at : null,
      about: entry.service,
    },
  ];
  const byCaller = new Map<string, Hop[]>();
  for (const h of trace.hops) byCaller.set(h.from, [...(byCaller.get(h.from) ?? []), h]);
  // Each service's calls hang under the first row that reached it
  const placed = new Set([entry.service]);
  const visit = (service: string, parent: number, depth: number) => {
    for (const h of byCaller.get(service) ?? []) {
      const failed = h.state !== "ok" && h.state !== "pending";
      const kind: NodeKind = failed ? "failed" : h.kind === "external" ? "external" : (kinds.get(h.to) ?? "container");
      rows.push({
        key: `${h.from}>${h.to}:${h.port ?? ""}`,
        depth,
        parent,
        name: h.to,
        port: h.port,
        kind,
        tone: failed ? "bad" : h.state === "pending" ? "wait" : h.kind === "external" ? "external" : "ok",
        ...hopLabel(h),
        at: h.at,
        ms: h.requests[0]?.ms ?? null,
        about: h.kind === "service" ? h.to : h.from,
      });
      if (h.kind === "service" && !failed && !placed.has(h.to)) {
        placed.add(h.to);
        visit(h.to, rows.length - 1, depth + 1);
      }
    }
  };
  visit(entry.service, 1, 2);
  return rows;
}

function notesFor(entry: Entry, trace: Trace): string[] {
  const notes: string[] = [];
  if (!entry.watching) {
    notes.push(`Docker isn't reachable, so calls between containers on ${entry.network} aren't traced.`);
  }
  for (const n of trace.nodes) {
    if (n.watched) continue;
    if (n.kind === "process") notes.push(`${n.name} runs on this Mac; only Node commands report their calls.`);
    else if (entry.watching)
      notes.push(`Watching ${n.name} started during this call. Send it again to see all of its calls.`);
  }
  if (trace.hops.length === 0 && trace.nodes.find((n) => n.name === entry.service)?.watched) {
    notes.push(`${entry.service} didn't call anything else.`);
  }
  return notes;
}

function CallTree({
  origin,
  entry,
  trace,
  focus,
  onFocus,
}: {
  origin: Origin;
  entry: Entry;
  trace: Trace;
  focus: string | null;
  onFocus: (name: string) => void;
}) {
  const rows = useMemo(() => buildRows(origin, entry, trace), [origin, entry, trace]);
  const window = Math.max(1, trace.to - origin.at);
  const y = (i: number) => PAD + i * ROW + ROW / 2;
  // As wide as the deepest, longest name needs, so the calls get the rest
  const treeWidth = Math.min(
    320,
    Math.max(
      ...rows.map(
        (r) =>
          markX(r.depth) +
          16 +
          Math.min(r.name.length, 18) * 7.4 +
          (r.port !== null && r.kind !== "failed" ? 8 + String(r.port).length * 6.8 : 0),
      ),
    ) + 12,
  );
  const lastChild = new Map<number, number>();
  rows.forEach((r, i) => r.parent !== null && lastChild.set(r.parent, i));

  return (
    <div className="trace__diagram">
      <div
        className="trace__tree"
        style={
          {
            "--tree": `${Math.ceil(treeWidth)}px`,
            "--indent": `${INDENT}px`,
            "--answered": Math.min(1, (origin.end - origin.at) / window),
            height: PAD * 2 + rows.length * ROW,
          } as CSSProperties
        }
      >
        <svg className="trace__lines" aria-hidden>
          {[...lastChild].map(([parent, last]) => (
            <path
              key={`trunk${parent}`}
              className="trace__trunk"
              d={`M${markX(rows[parent].depth)},${y(parent) + 9} V${y(last) - 7}`}
            />
          ))}
          {rows.map((r, i) => {
            if (r.parent === null) return null;
            const x = markX(rows[r.parent].depth);
            const end = markX(r.depth) - (r.kind === "failed" ? 9 : 12);
            return (
              <path
                key={r.key}
                d={`M${x},${y(i) - 7} Q${x},${y(i)} ${x + 7},${y(i)} H${end}`}
                pathLength={r.tone === "ok" || r.tone === "bad" ? 1 : undefined}
                data-tone={r.tone}
                data-dim={(focus && r.about !== focus) || undefined}
                style={{ "--i": i } as CSSProperties}
              />
            );
          })}
          {rows.map((r, i) =>
            r.parent === null || r.kind === "failed" ? null : (
              <circle
                key={`${r.key}:end`}
                r={2.5}
                cx={markX(r.depth) - 12}
                cy={y(i)}
                data-tone={r.tone}
                data-dim={(focus && r.about !== focus) || undefined}
                style={{ "--i": i } as CSSProperties}
              />
            ),
          )}
        </svg>
        {rows.map((r, i) => (
          <TreeRow
            key={r.key}
            row={r}
            index={i}
            start={(r.at - origin.at) / window}
            width={r.ms === null ? null : r.ms / window}
            focused={!!focus && r.about === focus}
            dim={!!focus && r.about !== focus && r.kind !== "you"}
            onFocus={() => r.about && onFocus(r.about)}
          />
        ))}
      </div>
    </div>
  );
}

function TreeRow({
  row,
  index,
  start,
  width,
  focused,
  dim,
  onFocus,
}: {
  row: TRow;
  index: number;
  start: number;
  width: number | null;
  focused: boolean;
  dim: boolean;
  onFocus: () => void;
}) {
  const Icon =
    row.kind === "you"
      ? Send
      : row.kind === "process"
        ? SquareTerminal
        : row.kind === "external"
          ? Globe
          : row.kind === "failed"
            ? X
            : Box;
  return (
    <button
      className="tr"
      data-kind={row.kind}
      data-root={row.key === "entry" || undefined}
      data-tone={row.tone}
      data-focus={focused || undefined}
      data-dim={dim || undefined}
      style={{ "--i": index, "--depth": row.depth } as CSSProperties}
      onClick={onFocus}
      title={row.kind === "you" ? undefined : `${row.name}${row.port ? `:${row.port}` : ""} · ${row.label}`}
    >
      <span className="tr__node">
        <span className="tr__mark">
          <Icon
            size={row.kind === "failed" ? 11 : 13}
            strokeWidth={row.kind === "failed" ? 2.5 : 1.75}
            className="icon"
          />
        </span>
        <span className="tr__name">{row.name}</span>
        {row.port !== null && row.kind !== "failed" && <span className="tr__port">:{row.port}</span>}
      </span>
      <span className="tr__call">
        <span className="tr__label">{row.label}</span>
        {row.status && (
          <span className="trace__status" data-class={row.status[0]}>
            {row.status}
          </span>
        )}
        {row.ms !== null && <span className="tr__ms">{row.ms} ms</span>}
      </span>
      <span className="tr__lane">
        {row.kind !== "you" && (
          <span
            className="tr__bar"
            data-tick={width === null || undefined}
            style={
              {
                "--x": Math.max(0, Math.min(1, start)),
                "--w": Math.min(width ?? 0, 1 - Math.max(0, start)),
              } as CSSProperties
            }
          />
        )}
      </span>
    </button>
  );
}

// ---- Timeline ----

type Row = {
  key: string;
  at: number;
  who: string;
  /** Services the row is about, for focusing */
  about: string[];
  kind: "call" | "fail" | "log";
  stream?: "out" | "err" | "sys";
  body: ReactNode;
};

function since(ms: number) {
  const sign = ms < 0 ? "−" : "+";
  const abs = Math.abs(ms);
  return abs < 1000 ? `${sign}${abs} ms` : `${sign}${(abs / 1000).toFixed(2)} s`;
}

function Status({ code, error }: { code: number | null; error?: string | null }) {
  if (code) {
    return (
      <span className="trace__status" data-class={String(code)[0]}>
        {code}
      </span>
    );
  }
  if (error) {
    return (
      <span className="trace__status" data-class="x">
        {error}
      </span>
    );
  }
  return null;
}

function Timeline({
  origin,
  entry,
  trace,
  logs,
  focus,
  onClear,
}: {
  origin: Origin;
  entry: Entry;
  trace: Trace;
  logs: ServiceLines[];
  focus: string | null;
  onClear: () => void;
}) {
  const rows = useMemo(() => {
    const out: Row[] = [];
    out.push({
      key: "origin",
      at: origin.at,
      who: "You",
      about: [entry.service],
      kind: "call",
      body: (
        <>
          <span className="trace__arrow">→ {entry.service}</span>
          <span className="trace__what">{origin.label}</span>
        </>
      ),
    });
    trace.hops.forEach((h, i) => {
      const to = `${h.to}${h.port ? `:${h.port}` : ""}`;
      const failed = h.state !== "ok" && h.state !== "pending";
      if (failed) {
        out.push({
          key: `h${i}`,
          at: h.at,
          who: h.from,
          about: [h.from, h.to],
          kind: "fail",
          body: (
            <>
              <span className="trace__arrow">✕ {to}</span>
              <span className="trace__what">{h.error ?? h.state}</span>
            </>
          ),
        });
      } else if (h.requests.length) {
        h.requests.forEach((r, j) =>
          out.push({
            key: `h${i}r${j}`,
            at: r.at,
            who: h.from,
            about: [h.from, h.to],
            kind: "call",
            body: (
              <>
                <span className="trace__arrow">→ {to}</span>
                <span className="trace__what">
                  {r.method} {r.path}
                </span>
                <Status code={r.status} error={r.error} />
                {r.ms !== null && <span className="trace__ms">{r.ms} ms</span>}
              </>
            ),
          }),
        );
      } else {
        out.push({
          key: `h${i}`,
          at: h.at,
          who: h.from,
          about: [h.from, h.to],
          kind: "call",
          body: (
            <>
              <span className="trace__arrow">→ {to}</span>
              <span className="trace__what">
                {h.state === "pending" ? "connecting" : h.count > 1 ? `${h.count} connections` : "connected"}
              </span>
            </>
          ),
        });
      }
    });
    for (const s of logs) {
      s.lines.forEach((l, j) =>
        out.push({
          key: `${s.service}:${j}`,
          at: l.at,
          who: s.service,
          about: [s.service],
          kind: "log",
          stream: l.stream,
          body: <span className="trace__text">{l.text}</span>,
        }),
      );
    }
    if (origin.end > origin.at)
      out.push({
        key: "answer",
        at: origin.end,
        who: entry.service,
        about: [entry.service],
        kind: origin.ok ? "call" : "fail",
        body: (
          <>
            <span className="trace__arrow">{origin.ok ? "→" : "✕"} You</span>
            <span className="trace__what">{origin.outcome}</span>
          </>
        ),
      });
    // Stable: at equal times, calls stay in the order they were made
    return out
      .map((r, i) => ({ r, i }))
      .sort((a, b) => a.r.at - b.r.at || a.i - b.i)
      .map(({ r }) => r);
  }, [origin, entry, trace, logs]);

  const services = useMemo(() => {
    const names = [entry.service, ...trace.nodes.map((n) => n.name)];
    return [...new Set(names)];
  }, [entry, trace]);
  const hue = (who: string) => (who === "You" ? -1 : services.indexOf(who) % 6);
  const shown = focus ? rows.filter((r) => r.about.includes(focus)) : rows;
  const logCount = logs.reduce((n, s) => n + s.lines.length, 0);

  return (
    <div className="trace__timeline">
      <div className="trace__timeline-head">
        <span>
          {focus ? (
            <>
              Showing <b>{focus}</b>
              <button className="trace__clear" onClick={onClear}>
                Show all
              </button>
            </>
          ) : (
            `${trace.hops.length} ${trace.hops.length === 1 ? "call" : "calls"} · ${logCount} log ${logCount === 1 ? "line" : "lines"}`
          )}
        </span>
        <span className="trace__window">{since(trace.to - origin.at)} window</span>
      </div>
      <div className="trace__rows selectable">
        {shown.map((r) => (
          <div key={r.key} className="trace__row" data-kind={r.kind} data-stream={r.stream}>
            <span className="trace__time">{since(r.at - origin.at)}</span>
            <span className="trace__who" data-hue={hue(r.who)} title={r.who}>
              {r.who}
            </span>
            <span className="trace__body">{r.body}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
