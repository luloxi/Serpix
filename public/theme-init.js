try {
  var t = localStorage.getItem("serpix-theme") === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t;
} catch {
  /* private mode or storage disabled */
}

