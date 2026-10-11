import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Landing } from "./Landing.tsx";
import { Session } from "./Session.tsx";
import "./styles.css";

function currentSession(): string | null {
	const m = window.location.pathname.match(/^\/s\/([a-z0-9]{6,12})\/?$/);
	return m ? m[1] : null;
}

function App() {
	const [session, setSession] = useState<string | null>(currentSession());
	useEffect(() => {
		const onPop = () => setSession(currentSession());
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);
	return session ? <Session id={session} key={session} /> : <Landing />;
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
