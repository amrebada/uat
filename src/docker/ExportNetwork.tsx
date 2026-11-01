import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Box,
  Check,
  CircleAlert,
  Copy,
  FileUp,
  Folder,
  FolderGit2,
  Layers,
  Link2,
  Lock,
  SquareTerminal,
  X,
} from "lucide-react";
import { message } from "../lib/tauri";
import { ICON, Spinner, useDismiss } from "../ui";
import { SUFFIX, WHY, fileOf, fileText, type BuildFrom, type Draft, type Entry, type SharedService } from "./share";
import { draftWith, exportSource, pickBuild, shareApi, type ExportSource } from "./shareRun";
import "./share.css";

const MASK = "••••••";

/** Items in order, under the service each is for */
export function byService<T extends { service: string }>(items: T[]): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const i of items) out.set(i.service, [...(out.get(i.service) ?? []), i]);
  return [...out];
}

/** How a service runs, said briefly */
export function howItRuns(s: SharedService): {
  icon: typeof Box;
  text: string;
} {
  if (s.build) {
    const where = [s.build.repo, s.build.path].filter(Boolean).join("/");
    return {
      icon: Box,
      text: `built from ${where}${s.build.dockerfile ? `, ${s.build.dockerfile}` : ""}`,
    };
  }
  if (s.run) {
    const cmd = typeof s.run.command === "string" ? s.run.command : "a command asked for";
    return {
      icon: SquareTerminal,
      text: `${cmd}, in ${[s.run.repo, s.run.path].filter(Boolean).join("/")}`,
    };
  }
  if (s.attached) return { icon: Link2, text: `${s.attached.image}, attached` };
  return { icon: Layers, text: s.local ? `${s.image}, built on the exporter's Mac` : (s.image ?? "") };
}

/** Writes a network to a file for git: shows what goes in, and has the
 *  person choose, value by value, what's shared and what's asked for, and
 *  the folder that builds an image only this Mac has. */
export function ExportNetwork({ network, onClose }: { network: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<ExportSource | null>(null);
  const [builds, setBuilds] = useState<Record<string, BuildFrom>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  useDismiss(ref, onClose, !busy);

  useEffect(() => {
    exportSource(network)
      .then(async (s) => {
        setSrc(s);
        setDraft(await draftWith(s));
      })
      .catch((e) => setError(message(e)));
  }, [network]);

  // An image built from a folder instead: the file again, keeping each value's choice
  const rebuild = async (next: Record<string, BuildFrom>) => {
    if (!src) return;
    setSaved(null);
    setError(null);
    try {
      const d = await draftWith(src, next);
      setBuilds(next);
      setDraft((prev) => {
        if (!prev) return d;
        const was = new Map(prev.entries.map((e) => [e.key, e.share]));
        return {
          ...d,
          entries: d.entries.map((e) => (e.locked || !was.has(e.key) ? e : { ...e, share: was.get(e.key)! })),
        };
      });
    } catch (e) {
      setError(message(e));
    }
  };

  const link = async (service: string) => {
    try {
      const b = await pickBuild(service);
      if (b) await rebuild({ ...builds, [service]: b });
    } catch (e) {
      setError(message(e));
    }
  };

  const unlink = (service: string) => {
    const { [service]: _, ...rest } = builds;
    rebuild(rest);
  };

  const text = useMemo(() => (draft ? fileText(fileOf(draft)) : ""), [draft]);
  const asked = draft?.entries.filter((e) => e.locked || !e.share).length ?? 0;
  const services = draft ? Object.entries(draft.services) : [];

  const choose = (key: string, share: boolean) => {
    setSaved(null);
    setDraft(
      (d) =>
        d && {
          ...d,
          entries: d.entries.map((e) => (e.key === key ? { ...e, share } : e)),
        },
    );
  };

  const write = async () => {
    setError(null);
    const path = await save({
      defaultPath: `${network}${SUFFIX}`,
      filters: [{ name: "UAT network", extensions: ["json"] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      setSaved(await shareApi.write(path, text));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      (e) => setError(message(e)),
    );

  return (
    <div className="xfer__scrim">
      <div ref={ref} className="popover xfer" role="dialog" aria-modal="true" aria-labelledby="xfer-title">
        <header className="xfer__head">
          <span className="xfer__icon" data-done={saved ? true : undefined}>
            {saved ? <Check {...ICON} /> : <FileUp {...ICON} />}
          </span>
          <div>
            <h2 id="xfer-title">Export {network}</h2>
            <p>
              A file to keep in git and share. Whatever only works on this Mac is asked for when someone imports it.
            </p>
          </div>
          <button className="icon-btn xfer__x" title="Close" onClick={onClose}>
            <X {...ICON} />
          </button>
        </header>

        <div className="xfer__body">
          {!draft && !error && (
            <div className="xfer__loading">
              <Spinner /> Looking at what runs on it…
            </div>
          )}
          {draft && !services.length && (
            <p className="xfer__note">Nothing runs on it yet, so the file would be empty.</p>
          )}
          {draft && services.length > 0 && (
            <>
              {Object.keys(draft.repos).length > 0 && (
                <section>
                  <h3>Repos</h3>
                  <ul className="xfer__list">
                    {Object.entries(draft.repos).map(([name, r]) => (
                      <li key={name} className="xfer__row">
                        {r.git ? <FolderGit2 {...ICON} /> : <Folder {...ICON} />}
                        <span className="xfer__name">{name}</span>
                        <span className="xfer__meta">{r.git ?? "not in git: each person picks the folder"}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section>
                <h3>Services</h3>
                <ul className="xfer__list">
                  {services.map(([name, s]) => {
                    const how = howItRuns(s);
                    const image = draft.images.find((i) => i.service === name);
                    const here = image?.local && !image.build;
                    const text = here ? `${image.image}, only on this Mac` : how.text;
                    return (
                      <li key={name} className="xfer__row">
                        <how.icon {...ICON} />
                        <span className="xfer__name">{name}</span>
                        <span className="xfer__meta" data-warn={here || undefined} title={text}>
                          {text}
                        </span>
                        {here && (
                          <button
                            className="xfer__link"
                            title="Choose the folder with its Dockerfile, so others build it from that repo"
                            onClick={() => link(name)}
                          >
                            Build from…
                          </button>
                        )}
                        {image?.build && (
                          <button
                            className="xfer__link"
                            title={`Run ${image.image} instead`}
                            onClick={() => unlink(name)}
                          >
                            Use image
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              {draft.entries.length > 0 && (
                <section>
                  <h3>
                    Values <span className="xfer__count">{asked ? `${asked} asked for on import` : "all shared"}</span>
                  </h3>
                  <ul className="xfer__list xfer__values">
                    {byService(draft.entries).map(([service, entries]) => [
                      <li key={service} className="xfer__group">
                        {service}
                      </li>,
                      ...entries.map((e) => (
                        <ValueRow key={e.key} entry={e} onChoose={(share) => choose(e.key, share)} />
                      )),
                    ])}
                  </ul>
                </section>
              )}

              {draft.notes.some((n) => !n.local) && (
                <ul className="xfer__notes">
                  {draft.notes
                    .filter((n) => !n.local)
                    .map((n) => (
                      <li key={n.text}>
                        <CircleAlert size={14} strokeWidth={1.75} className="icon" />
                        {n.text}
                      </li>
                    ))}
                </ul>
              )}

              <details className="xfer__file">
                <summary>See the file</summary>
                <pre>{text}</pre>
              </details>
            </>
          )}
        </div>

        <footer className="xfer__foot">
          {error ? (
            <span className="xfer__error" title={error}>
              <CircleAlert size={14} strokeWidth={1.75} className="icon" />
              {error}
            </span>
          ) : saved ? (
            <span className="xfer__saved" title={saved}>
              <Check {...ICON} />
              Saved to {saved.split("/").pop()}
            </span>
          ) : (
            <span />
          )}
          <button className="btn" disabled={!draft || !services.length} onClick={copy}>
            {copied ? <Check {...ICON} /> : <Copy {...ICON} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="btn-primary" disabled={!draft || !services.length || busy} onClick={write}>
            {busy ? <Spinner /> : <FileUp {...ICON} />}
            Save…
          </button>
        </footer>
      </div>
    </div>
  );
}

function ValueRow({ entry: e, onChoose }: { entry: Entry; onChoose: (share: boolean) => void }) {
  const hidden = e.why === "secret";
  return (
    <li className="xfer__value">
      <div className="xfer__line">
        <span className="xfer__key">{e.name}</span>
        {e.locked ? (
          <span className="xfer__lock" title="It only works on this Mac, so it's always asked for">
            <Lock size={12} strokeWidth={1.75} className="icon" />
            Asked
          </span>
        ) : (
          <div className="segmented xfer__seg" role="group" aria-label={`${e.service} ${e.name}`}>
            <button data-active={e.share || undefined} onClick={() => onChoose(true)}>
              Share
            </button>
            <button data-active={!e.share || undefined} onClick={() => onChoose(false)}>
              Ask
            </button>
          </div>
        )}
      </div>
      <div className="xfer__line">
        <span className="xfer__val" title={hidden ? undefined : e.value}>
          {e.value === "" ? "empty" : hidden ? MASK : e.value}
        </span>
        {e.why && (
          <span className="xfer__why" data-why={e.why}>
            {WHY[e.why]}
          </span>
        )}
      </div>
    </li>
  );
}
