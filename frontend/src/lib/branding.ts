// ponytail: build-time env, not a settings row — rebranding a self-hosted install is a deploy, not a click.
export const APP_NAME = import.meta.env.VITE_APP_NAME || "Larika";
// ponytail: WhatsApp for now — a help page or ticketing when there is one
export const SUPPORT_URL = import.meta.env.VITE_SUPPORT_URL || "https://wa.me/6281266235940";
