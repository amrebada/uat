/** Sample data for `npm run dev` in a plain browser, where there is no Rust
 *  side to reach Docker. Lets the canvas be worked on without the app. */
import type { EngineStatus, NetworkInfo, NetworkPlan, NetworkRemoved, Service } from "./api";
import type { GitInfo, Snapshot } from "./share";

const svc = (s: Partial<Service> & Pick<Service, "name" | "image">): Service => ({
  id: `mock-${s.name}`,
  containerName: `uat-net-${s.name}`,
  state: "running",
  status: "Up 2 hours",
  ports: [],
  dependsOn: [],
  kind: "image",
  source: s.image,
  managed: true,
  ...s,
});

export const mock = {
  status: (): EngineStatus => ({ connected: true, socket: "(browser preview)", version: "sample data", error: null }),
  networks: (): NetworkInfo[] => [{ id: "mock", name: "uat-net", driver: "bridge", managed: true }],
  services: (): Service[] => [
    svc({
      name: "rides-api",
      image: "uat/rides-api:latest",
      kind: "dockerfile",
      source: "~/code/rides-api",
      ports: [{ container: 3000, host: 3000 }],
      dependsOn: ["postgres", "redis"],
    }),
    svc({ name: "dispatch", image: "uat/dispatch:latest", kind: "dockerfile", dependsOn: ["redis", "kafka"], state: "exited", status: "Exited (1) 5 minutes ago" }),
    svc({ name: "postgres", image: "postgres:16", ports: [{ container: 5432, host: 15432 }] }),
    svc({ name: "redis", image: "redis:7-alpine", ports: [{ container: 6379, host: null }] }),
    svc({ name: "kafka", image: "bitnami/kafka:3.7", kind: "external", managed: false, ports: [{ container: 9092, host: null }] }),
  ],
  plan: (network: string): NetworkPlan => {
    const all = mock.services();
    const mine = all.filter((s) => s.managed);
    return {
      network,
      recreated: network === "uat-net",
      containers: mine.map((s) => ({ id: s.id, name: s.name, image: s.image, state: s.state })),
      attached: all.filter((s) => !s.managed).map((s) => ({ id: s.id, name: s.containerName, image: s.image, state: s.state })),
      commands: [{ id: "sample-web", name: "rides-web", running: true }],
      images: [
        { id: "sha256:1", names: ["uat/rides-api:latest"], size: "212.4 MB", kept: null },
        { id: "sha256:2", names: ["uat/dispatch:latest"], size: "188.0 MB", kept: null },
        { id: "sha256:3", names: ["postgres:16"], size: "431.7 MB", kept: null },
        { id: "sha256:4", names: ["redis:7-alpine"], size: "41.2 MB", kept: "used by uat-demo-redis" },
      ],
      volumes: [
        { name: "rides-pg-data", anonymous: false, kept: null },
        { name: "9f3c1e7a0b52d84e6a1f0c9d27b3e5a48c61f2d09e7b4a3c5d8e1f6a2b9c0d7e", anonymous: true, kept: null },
      ],
    };
  },
  others: (): Service[] => [
    svc({ name: "compose-redis-1", containerName: "compose-redis-1", image: "redis:7-alpine", kind: "external", managed: false }),
  ],
  /** What exporting the sample network reads: env as given, on a Mac with a home and user */
  snapshot: (network: string): Snapshot => ({
    network,
    machine: { home: "/Users/you", user: "you", host: "Your-MacBook-Pro" },
    containers: [
      {
        name: "rides-api",
        containerName: "rides-api",
        kind: "dockerfile",
        image: "uat/rides-api:latest",
        context: "~/code/rides-api",
        dockerfile: null,
        env: [
          "NODE_ENV=development",
          "DATABASE_URL=postgres://rides:rides@postgres:5432/rides",
          "JWT_SECRET=dev-only-9f3c1e7a",
          "UPLOADS_DIR=/Users/you/rides/uploads",
          "CONFIG_FILE=./config/local.json",
          "REDIS_URL=redis://redis:6379",
        ],
        ports: [{ container: 3000, host: 3000 }],
        dependsOn: ["postgres", "redis"],
        imageLocal: true,
      },
      {
        name: "postgres",
        containerName: "postgres",
        kind: "image",
        image: "postgres:16",
        context: null,
        dockerfile: null,
        env: ["POSTGRES_USER=rides", "POSTGRES_PASSWORD=rides", "POSTGRES_DB=rides"],
        ports: [{ container: 5432, host: 15432 }],
        dependsOn: [],
        imageLocal: false,
      },
      {
        name: "mailer",
        containerName: "mailer",
        kind: "image",
        image: "uat/mailer:dev",
        context: null,
        dockerfile: null,
        env: ["SMTP_HOST=mailhog"],
        ports: [],
        dependsOn: [],
        imageLocal: true,
      },
      {
        name: "redis",
        containerName: "compose-redis-1",
        kind: "attached",
        image: "redis:7-alpine",
        context: null,
        dockerfile: null,
        env: [],
        ports: [{ container: 6379, host: null }],
        dependsOn: [],
        imageLocal: false,
      },
    ],
  }),
  git: (path: string): GitInfo | null =>
    path.includes("rides-api")
      ? { root: "/Users/you/code/rides-api", repo: "github.com/yassir/rides-api", url: "git@github.com:yassir/rides-api.git", path: "" }
      : path.includes("rides-mailer")
        ? { root: "/Users/you/code/rides-mailer", repo: "github.com/yassir/rides-mailer", url: "git@github.com:yassir/rides-mailer.git", path: "" }
        : path.includes("rides-web")
        ? { root: "/Users/you/code/rides-web", repo: "github.com/yassir/rides-web", url: "https://github.com/yassir/rides-web.git", path: "" }
        : null,
  removed: (network: string, images: boolean, volumes: boolean): NetworkRemoved => {
    const p = mock.plan(network);
    return {
      network,
      recreated: p.recreated,
      containers: p.containers.map((c) => c.name),
      disconnected: p.attached.map((c) => c.name),
      commands: p.commands.map((c) => c.name),
      images: images ? p.images.filter((i) => !i.kept).map((i) => i.names.join(", ")) : [],
      volumes: volumes ? p.volumes.filter((v) => !v.kept).map((v) => v.name) : [],
      kept: images ? p.images.filter((i) => i.kept).map((i) => `${i.names.join(", ")}: ${i.kept}`) : [],
    };
  },
};
