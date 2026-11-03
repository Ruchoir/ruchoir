/**
 * The pre-paint script (see `app/layout.tsx`): reads the persisted settings and stamps
 * data-theme, data-style, data-font and data-text on <html> before the first paint, so a night
 * theme or a simplified style never flashes the default first. The theme is the accent plus the
 * mode (day, night, or the device's own in automatic); a single stored `theme` from before the
 * split is read for what it meant. The style is stamped only when it is one of the four (no
 * attribute is the Ruchoir style). Kept inline and tiny, in a module of its own so Node tests it.
 */
export const themeBootstrap = `try{var s=JSON.parse(localStorage.getItem("ruchoir.settings")||"{}"),d=document.documentElement.dataset;var A=/^(sky|mint|violet|pink)$/,a=s.accent,m=s.mode,t=s.theme||"";if(!A.test(a)){var p=t.split(/-(?=dark$)/);a=A.test(p[0])?p[0]:"sky";m=t?(p[1]==="dark"||t==="dark"?"night":"day"):"day";}var n=m==="night"||(m==="auto"&&matchMedia("(prefers-color-scheme: dark)").matches),h=a+(n?"-dark":"");if(h!=="sky")d.theme=h;var S=/^(aubergine|nuage|indigo|marine)$/;if(S.test(s.style))d.style=s.style;if(s.font==="system"||s.font==="dyslexic")d.font=s.font;if(s.textSize==="s"||s.textSize==="l"||s.textSize==="xl")d.text=s.textSize;}catch(e){}`;
