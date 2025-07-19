export interface App {
  id: string;
  name: string;
  domain: string;
  type: "nodejs" | "static";
  status: "running" | "stopped" | "error";
  port?: number;
  memory?: string;
  cpu?: string;
  uptime?: string;
  lastDeployment?: string;
}