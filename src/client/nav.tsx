export function navigate(path: string) {
	window.history.pushState({}, "", path);
	window.dispatchEvent(new PopStateEvent("popstate"));
}

export function Brand() {
	return (
		<a className="brand" href="/" onClick={(e) => (e.preventDefault(), navigate("/"))}>
			<svg viewBox="0 0 32 32" aria-hidden="true">
				<rect width="32" height="32" rx="7" fill="currentColor" opacity="0.92" />
				<path d="M9 23h14M12 23V12m8 11V12M8 12h16l-8-5z" fill="none" stroke="#f6c453" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
			Precedent
			<small>agents write the code · you set the precedent</small>
		</a>
	);
}
