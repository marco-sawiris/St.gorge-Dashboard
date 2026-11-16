const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./web-CDNqa2Wf.js","./index-C3T-3lKG.js","./rolldown-runtime-DpEnGzO4.js","./vendor-react-1U1rKQOa.js","./vendor-icons-BkdHgiDE.js","./vendor-motion-BMLsRi6e.js","./index-DhauoANc.css"])))=>i.map(i=>d[i]);
import { n as registerPlugin, r as __vitePreload } from "./index-C3T-3lKG.js";
// node_modules/@capacitor/local-notifications/dist/esm/definitions.js
/**
* Day of the week. Used for scheduling notifications on a particular weekday.
*/
var Weekday;
(function(Weekday) {
	Weekday[Weekday["Sunday"] = 1] = "Sunday";
	Weekday[Weekday["Monday"] = 2] = "Monday";
	Weekday[Weekday["Tuesday"] = 3] = "Tuesday";
	Weekday[Weekday["Wednesday"] = 4] = "Wednesday";
	Weekday[Weekday["Thursday"] = 5] = "Thursday";
	Weekday[Weekday["Friday"] = 6] = "Friday";
	Weekday[Weekday["Saturday"] = 7] = "Saturday";
})(Weekday || (Weekday = {}));
// node_modules/@capacitor/local-notifications/dist/esm/index.js
var LocalNotifications = registerPlugin("LocalNotifications", { web: () => __vitePreload(() => import("./web-CDNqa2Wf.js").then((m) => new m.LocalNotificationsWeb()), __vite__mapDeps([0,1,2,3,4,5,6]), import.meta.url) });
export { LocalNotifications, Weekday };
