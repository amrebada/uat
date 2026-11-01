/** The room a scrollbar takes here, as `--scrollbar` on the page: 0 with
 *  macOS's overlay scrollbars, about 17px when they're always shown (System
 *  Settings → Appearance, or with a mouse). Panels that keep room for their
 *  scrollbar take it out of their right padding, so their insets stay even
 *  (see `--scrollbar` in base.css). */
export function watchScrollbars() {
  const probe = document.createElement("div");
  probe.style.cssText = "position: fixed; top: -200px; width: 100px; height: 100px; overflow: scroll; visibility: hidden";
  document.body.append(probe);
  const measure = () =>
    document.documentElement.style.setProperty("--scrollbar", `${probe.offsetWidth - probe.clientWidth}px`);
  measure();
  // The setting can change while UAT is open: look again when it comes back
  window.addEventListener("focus", measure);
  window.addEventListener("resize", measure);
}
