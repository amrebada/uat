import { useEffect, useRef, useState } from "react";
import { Box, Check, CircleAlert, Database, Layers, Link2, SquareTerminal, Trash2, X } from "lucide-react";
import { message } from "../lib/tauri";
import { ICON, Spinner, useDismiss } from "../ui";
import { docker, networkRemoved, onNetworkProgress, type NetworkPlan, type NetworkRemoved } from "./api";

const shortId = (id: string) => (/^[0-9a-f]{64}$/.test(id) ? id.slice(0, 12) : id);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function Row({ icon: Icon, name, meta, faint }: { icon: typeof Box; name: string; meta?: string; faint?: boolean }) {
  return (
    <li className="rmnet__row" data-faint={faint || undefined}>
      <Icon {...ICON} />
      <span className="rmnet__name">{name}</span>
      {meta && <span className="rmnet__meta">{meta}</span>}
    </li>
  );
}

/** Asks before removing a network: lists what goes with it, with images
 *  and volumes as choices, then shows what went and what stayed. */
export function RemoveNetwork({ network, onClose }: { network: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [plan, setPlan] = useState<NetworkPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState(true);
  const [volumes, setVolumes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState("");
  const [done, setDone] = useState<NetworkRemoved | null>(null);
  useDismiss(ref, onClose, !busy);

  useEffect(() => {
    docker.networkPlan(network).then(setPlan, (e) => setError(message(e)));
    const off = onNetworkProgress((p) => p.network === network && setLine(p.line));
    return () => {
      off.then((f) => f());
    };
  }, [network]);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await docker.removeNetwork(network, images, volumes);
      setDone(out);
      networkRemoved(network);
    } catch (e) {
      setError(message(e));
      // Some of it may be gone: show what's left
      docker.networkPlan(network).then(setPlan, () => {});
    } finally {
      setBusy(false);
    }
  };

  const goingImages = plan?.images.filter((i) => !i.kept) ?? [];
  const goingVolumes = plan?.volumes.filter((v) => !v.kept) ?? [];
  const removed = (plan?.containers.length ?? 0) + (plan?.commands.length ?? 0);
  const empty = plan && !removed && !plan.attached.length;

  return (
    <div className="rmnet__scrim">
      <div ref={ref} className="popover rmnet" role="dialog" aria-modal="true" aria-labelledby="rmnet-title">
        <header className="rmnet__head">
          <span className="rmnet__icon" data-done={done ? true : undefined}>
            {done ? <Check {...ICON} /> : <Trash2 {...ICON} />}
          </span>
          <div>
            <h2 id="rmnet-title">{done ? `Removed ${network}` : `Remove ${network}?`}</h2>
            <p>
              {done
                ? done.recreated
                  ? `It's UAT's default network, so it was made again, empty.`
                  : "It's gone from Docker."
                : "The network goes from Docker, with what UAT runs on it."}
            </p>
          </div>
          {!busy && (
            <button className="icon-btn rmnet__x" title="Close" onClick={onClose}>
              <X {...ICON} />
            </button>
          )}
        </header>

        <div className="rmnet__body">
          {!plan && !error && (
            <div className="rmnet__loading">
              <Spinner /> Looking at what's on it…
            </div>
          )}

          {done ? (
            <Result done={done} />
          ) : (
            plan && (
              <>
                {empty && <p className="rmnet__note">Nothing runs on it.</p>}
                {removed > 0 && (
                  <section>
                    <h3>Removed</h3>
                    <ul>
                      {plan.containers.map((c) => (
                        <Row key={c.id} icon={Box} name={c.name} meta={c.image} />
                      ))}
                      {plan.commands.map((c) => (
                        <Row
                          key={c.id}
                          icon={SquareTerminal}
                          name={c.name}
                          meta={c.running ? "command, stopped and deleted" : "command, deleted"}
                        />
                      ))}
                    </ul>
                  </section>
                )}
                {plan.attached.length > 0 && (
                  <section>
                    <h3>Disconnected, left running</h3>
                    <ul>
                      {plan.attached.map((c) => (
                        <Row key={c.id} icon={Link2} name={c.name} meta={c.image} />
                      ))}
                    </ul>
                  </section>
                )}
                {plan.images.length > 0 && (
                  <section>
                    <label className="rmnet__choice">
                      <input type="checkbox" checked={images} disabled={busy} onChange={(e) => setImages(e.target.checked)} />
                      <span>
                        Also remove {goingImages.length === plan.images.length ? "their" : "the"}{" "}
                        {plural(goingImages.length, "image")}
                      </span>
                    </label>
                    <ul data-off={!images || undefined}>
                      {plan.images.map((i) => (
                        <Row
                          key={i.id}
                          icon={Layers}
                          name={i.names.map(shortId).join(", ")}
                          meta={i.kept ? `kept, ${i.kept}` : i.size}
                          faint={!!i.kept}
                        />
                      ))}
                    </ul>
                  </section>
                )}
                {plan.volumes.length > 0 && (
                  <section>
                    <label className="rmnet__choice">
                      <input type="checkbox" checked={volumes} disabled={busy} onChange={(e) => setVolumes(e.target.checked)} />
                      <span>Also remove {plural(goingVolumes.length, "volume")}, and the data in them</span>
                    </label>
                    <ul data-off={!volumes || undefined}>
                      {plan.volumes.map((v) => (
                        <Row
                          key={v.name}
                          icon={Database}
                          name={v.anonymous ? `${shortId(v.name)}` : v.name}
                          meta={v.kept ? `kept, ${v.kept}` : v.anonymous ? "anonymous" : undefined}
                          faint={!!v.kept}
                        />
                      ))}
                    </ul>
                  </section>
                )}
                {plan.recreated && (
                  <p className="rmnet__note">It's UAT's default network, so UAT makes it again, empty.</p>
                )}
              </>
            )
          )}
        </div>

        <footer className="rmnet__foot">
          {error ? (
            <span className="rmnet__error" title={error}>
              <CircleAlert size={14} strokeWidth={1.75} className="icon" />
              {error}
            </span>
          ) : busy ? (
            <span className="rmnet__progress">
              <Spinner /> {line || "Removing…"}
            </span>
          ) : (
            <span />
          )}
          {done ? (
            <button className="btn-primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button className="btn" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              <button className="btn-primary rmnet__go" disabled={!plan || busy} onClick={go}>
                {busy ? <Spinner /> : <Trash2 {...ICON} />}
                Remove network
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function Result({ done }: { done: NetworkRemoved }) {
  const lines: [string, string[]][] = [
    ["Containers removed", done.containers],
    ["Commands deleted", done.commands],
    ["Disconnected", done.disconnected],
    ["Images removed", done.images],
    ["Volumes removed", done.volumes.map(shortId)],
  ];
  const any = lines.some(([, l]) => l.length);
  return (
    <>
      {any ? (
        <ul className="rmnet__result">
          {lines
            .filter(([, l]) => l.length)
            .map(([label, l]) => (
              <li key={label}>
                <Check {...ICON} />
                <span className="rmnet__name">{label}</span>
                <span className="rmnet__meta">{l.join(", ")}</span>
              </li>
            ))}
        </ul>
      ) : (
        <p className="rmnet__note">Nothing else was on it.</p>
      )}
      {done.kept.length > 0 && (
        <section>
          <h3>Kept</h3>
          <ul>
            {done.kept.map((k) => (
              <Row key={k} icon={CircleAlert} name={k} faint />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
