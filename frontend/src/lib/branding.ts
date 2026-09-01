// ponytail: build-time env, not a settings row — rebranding a self-hosted install is a deploy, not a click.
export const APP_NAME = import.meta.env.VITE_APP_NAME || "CommitBase";
export const APP_TAGLINE = import.meta.env.VITE_APP_TAGLINE || "Self-hosted platform";
