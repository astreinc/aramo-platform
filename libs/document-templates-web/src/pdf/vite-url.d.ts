// The Vite `?url` import of the pdf.js worker (pdf.ts) — a bundler URL string. The lib is
// type-checked with types: ["node"] (no vite/client), so it declares just this one form.
declare module '*?url' {
  const url: string;
  export default url;
}
