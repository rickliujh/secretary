/** Resolves base URL, deployment and auth for Jira or Confluence from settings and the keychain. */
import { Effect, Option } from "effect";
import { allowHost } from "@/services/http/guard";
import { Secrets, secretNames } from "@/services/secrets";
import { Settings } from "@/services/settings";
import {
  type AtlassianAuth,
  confluenceApiBase,
  type Deployment,
  jiraApiBase,
  resolveDeployment,
  TOKEN_HELP,
} from "./deployment";

export type Product = "jira" | "confluence";

/** Form values override stored ones so settings can test before saving. */
export type Credentials = { baseUrl?: string; pat?: string; email?: string };

export type Resolved = {
  deployment: Deployment;
  apiBase: string;
  siteUrl: string;
  auth: AtlassianAuth;
};

export class MissingCredentials {
  readonly _tag = "MissingCredentials";
  constructor(readonly message: string) {}
}

const origin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

export const resolveCredentials = (product: Product, overrides: Credentials = {}) =>
  Effect.gen(function* () {
    const settings = yield* (yield* Settings).get.pipe(
      Effect.mapError((e) => new MissingCredentials(e.message)),
    );
    const secrets = yield* Secrets;
    const secret = (name: string) =>
      secrets.get(name).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((e) => new MissingCredentials(e.message)),
      );
    const conf = settings[product];
    // A URL typed into the settings form may be tested before it is saved (D27).
    if (overrides.baseUrl?.trim()) allowHost(overrides.baseUrl.trim());
    const siteUrl = overrides.baseUrl?.trim() || conf.baseUrl;
    const label = product === "jira" ? "Jira" : "Confluence";
    if (!siteUrl)
      return yield* Effect.fail(new MissingCredentials(`Set the ${label} base URL in Settings.`));
    const deployment = resolveDeployment(siteUrl, conf.deployment);

    let token =
      overrides.pat?.trim() ||
      (yield* secret(product === "jira" ? secretNames.jiraPat : secretNames.confluencePat));
    let email = overrides.email?.trim() || conf.email;
    // One Atlassian API token covers Jira and Confluence on the same Cloud site.
    if (
      product === "confluence" &&
      deployment === "cloud" &&
      origin(siteUrl) === origin(settings.jira.baseUrl)
    ) {
      token ||= yield* secret(secretNames.jiraPat);
      email ||= settings.jira.email;
    }
    if (!token)
      return yield* Effect.fail(
        new MissingCredentials(`Set ${TOKEN_HELP[deployment]} for ${label} in Settings.`),
      );
    if (deployment === "cloud" && !email) {
      return yield* Effect.fail(
        new MissingCredentials(
          `${label} Cloud needs your Atlassian account email with the API token.`,
        ),
      );
    }
    const auth: AtlassianAuth =
      deployment === "cloud" ? { type: "basic", email, token } : { type: "bearer", token };
    const apiBase =
      product === "jira"
        ? jiraApiBase(siteUrl, deployment)
        : confluenceApiBase(siteUrl, deployment);
    return { deployment, apiBase, siteUrl, auth } satisfies Resolved;
  });
