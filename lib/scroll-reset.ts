/** Window plus any pane inside the shell that the user had scrolled. */
export function resetScroll(doc: Document, win: Window): void {
  win.scrollTo({ top: 0, left: 0, behavior: "instant" });
  doc.documentElement.scrollTop = 0;
  doc.body.scrollTop = 0;
  const shell = doc.querySelector(".app-shell");
  if (!shell) return;
  for (const el of shell.querySelectorAll("*")) {
    if (el.scrollTop > 0) el.scrollTop = 0;
  }
}
