// Apply the saved theme before first paint (avoids a flash). External file so the CSP can forbid inline scripts.
try {
  var t = localStorage.getItem('studyai.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
