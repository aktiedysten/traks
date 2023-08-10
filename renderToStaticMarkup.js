// Because once we are using the CDN version of the ReactDOMServer,
// the function renderToStaticMarkup does not exist on ReactDOMServer
// and render_static errors. The function does exit on the browser version
// which might not work in Native
let renderToStaticMarkup;
try {
  renderToStaticMarkup = require("react-dom/server.browser").renderToStaticMarkup;
} catch (error) {
  renderToStaticMarkup = require("react-dom/server").renderToStaticMarkup;
}

export {
    renderToStaticMarkup
}
