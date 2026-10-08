import { platform } from "./webos/platform";
import App from "./ui/App.svelte";
import "./ui/theme.css";

platform.init();

new App({
  target: document.getElementById("app")!,
});
