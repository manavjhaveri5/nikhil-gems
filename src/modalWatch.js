/* Every popup in the app is a `position: fixed; inset: 0` backdrop with a
   background colour. While one is on screen, tag <html> with `modal-open` so
   theme.css can freeze the page behind it and hide the phone tab bar, which
   otherwise draws over the popup's buttons and steals the scroll. */
const SELECTOR = '[style*="position: fixed"][style*="inset: 0"][style*="background"]';

const isOpen = el => {
  const s = el.style;
  if (s.pointerEvents === "none" || s.display === "none" || s.visibility === "hidden") return false;
  return el.getClientRects().length > 0;
};

export function watchModals() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  let frame = 0;
  const check = () => {
    frame = 0;
    const open = [...document.querySelectorAll(SELECTOR)].some(isOpen);
    root.classList.toggle("modal-open", open);
  };
  new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(check); })
    .observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
  check();
}
