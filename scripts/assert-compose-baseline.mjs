// Assert properties of a resolved `docker compose config --format json` document
// read from stdin (issue #96). The mode argument selects the contract:
//
//   baseline — the portable, safe-by-default descriptor (compose.yml alone):
//              publishes only to loopback, binds the container itself to every
//              interface regardless of the host's OMXTERM_SERVER_HOST, needs no
//              pre-created external network, and pins no fixed container address.
//   prod     — the maintainer's production override (compose.yml + compose.prod.yml):
//              still joins the broker to a Compose-created, stably-named shared
//              network a separate-stack reverse proxy can attach to.
//
// Prints a "  FAIL: <reason>" line and exits 1 when the contract is violated;
// exits 0 otherwise. Kept as its own module so both checks share one parser
// instead of duplicating JSON logic across shell heredocs.

import { readFileSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "baseline" && mode !== "prod") {
  fail(`unknown mode "${mode ?? ""}"; expected "baseline" or "prod"`);
}

const config = JSON.parse(readFileSync(0, "utf8"));
const broker = config.services?.omxterm;
if (!broker) {
  fail("no omxterm service in the resolved compose config");
}

const networks = config.networks ?? {};

if (mode === "baseline") {
  assertLoopbackOnlyPublish(broker);
  assertContainerBindsAllInterfaces(broker);
  assertNoPreCreatedNetwork(networks);
  assertNoPinnedAddress(broker);
  assertNoGlobalContainerName(broker);
} else {
  assertReachableSharedNetwork(broker, networks);
}

process.exit(0);

function fail(reason) {
  console.error(`  FAIL: ${reason}`);
  process.exit(1);
}

// Loopback host addresses keep a published port on the local machine, so the
// broker is reachable only through a reverse proxy the operator deliberately
// puts in front of it — never on every interface by accident.
function isLoopbackHost(hostIp) {
  if (typeof hostIp !== "string") return false;
  const value = hostIp.trim().toLowerCase();
  return value === "::1" || value === "localhost" || value.startsWith("127.");
}

function assertLoopbackOnlyPublish(service) {
  const ports = service.ports ?? [];
  const published = ports.filter((port) => port.published !== undefined);
  if (published.length === 0) {
    fail(
      "the baseline publishes no host port, so the documented `docker compose up` " +
        "would leave the broker unreachable from a host reverse proxy",
    );
  }
  for (const port of published) {
    if (!isLoopbackHost(port.host_ip)) {
      fail(
        `published port ${port.published} binds host_ip "${port.host_ip ?? "<all interfaces>"}"; ` +
          "the safe-by-default baseline must bind published ports to loopback (e.g. 127.0.0.1)",
      );
    }
  }
}

// .env.example ships OMXTERM_SERVER_HOST=127.0.0.1 — the right default for
// local `npm run dev`, which runs the broker directly on the host — and a
// fresh clone's .env is typically copied straight from it. compose.yml loads
// that file via `env_file`, so without an explicit `environment:` override the
// value would leak into the container and make the broker bind its own
// loopback, unreachable from Docker's published port or an in-network proxy
// even though the port mapping below still resolves correctly.
function assertContainerBindsAllInterfaces(service) {
  const boundHost = service.environment?.OMXTERM_SERVER_HOST;
  if (boundHost !== "0.0.0.0") {
    fail(
      `omxterm resolves OMXTERM_SERVER_HOST to "${boundHost ?? "<unset>"}" inside the container; ` +
        'the baseline must pin it to "0.0.0.0" via `environment:` so .env.example\'s ' +
        "127.0.0.1 default (meant for local `npm run dev`) cannot shadow the container bind",
    );
  }
}

// An external network is created out of band, not by Compose, so a fresh clone
// could not `docker compose up` without pre-creating it first.
function assertNoPreCreatedNetwork(allNetworks) {
  for (const [key, network] of Object.entries(allNetworks)) {
    if (network?.external) {
      fail(
        `network "${key}" is declared external; a fresh clone would have to pre-create ` +
          "it before `docker compose up`, which the portable baseline must not require",
      );
    }
  }
}

// A pinned ipv4_address/ipv6_address couples the descriptor to one deployment's
// subnet — exactly the maintainer-specific topology the portable baseline drops.
function assertNoPinnedAddress(service) {
  for (const [key, attachment] of Object.entries(service.networks ?? {})) {
    if (attachment && (attachment.ipv4_address || attachment.ipv6_address)) {
      fail(
        `omxterm pins a fixed address on network "${key}" ` +
          `(${attachment.ipv4_address ?? attachment.ipv6_address}); the portable baseline must not`,
      );
    }
  }
}

// A fixed container_name is daemon-global: two projects that both set it cannot
// run at once, so a fresh clone would collide with any other OMXTerm container
// on the host and could not `docker compose up` alongside it. Unset, Compose
// derives a project-scoped name and the service name stays a network alias, so
// nothing needs a hardcoded name (issue #96).
function assertNoGlobalContainerName(service) {
  if (service.container_name) {
    fail(
      `omxterm pins a daemon-global container_name "${service.container_name}"; the portable ` +
        "baseline must let Compose derive a project-scoped name so a fresh clone can run " +
        "alongside another OMXTerm deployment instead of competing for one global name",
    );
  }
}

function assertReachableSharedNetwork(service, allNetworks) {
  const attached = Object.keys(service.networks ?? {});
  if (attached.length === 0) {
    fail("omxterm is on no explicit network; a separate-stack reverse proxy could not reach omxterm:3000");
  }
  for (const key of attached) {
    const network = allNetworks[key] ?? {};
    if (network.external) {
      fail(
        `omxterm network "${key}" is declared external; Compose would not create it, ` +
          "so the documented attach-and-reach path could not be bootstrapped from a clone",
      );
    }
    const resolvedName = network.name;
    const isStableShared =
      key !== "default" &&
      typeof resolvedName === "string" &&
      resolvedName.length > 0 &&
      !resolvedName.endsWith("_default");
    if (!isStableShared) {
      fail(
        `omxterm network "${key}" has no stable shared name a proxy can attach to ` +
          `(resolved: ${resolvedName || "<project default>"})`,
      );
    }
  }
}
