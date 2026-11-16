/** CSS Modules are compiled by the client bundle preset; the class map is typed here. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
