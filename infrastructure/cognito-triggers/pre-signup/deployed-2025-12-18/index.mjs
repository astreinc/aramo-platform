import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminLinkProviderForUserCommand,
  AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const client = new CognitoIdentityProviderClient({});

const USER_POOL_ID = process.env.USER_POOL_ID;
const ALLOWED_EMAIL_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const PRIMARY_IDP = (process.env.PRIMARY_IDP ?? "Microsoft").trim();
const REQUIRE_DEST_GROUP = (process.env.REQUIRE_DEST_GROUP ?? "").trim();

function getEmailDomain(email) {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

function parseProviderFromUsername(username) {
  // Handles "google_<id>" / "microsoft_<id>" (your pool format)
  const idx = username.indexOf("_");
  if (idx <= 0) return null;

  const rawProvider = username.slice(0, idx);
  const providerUserId = username.slice(idx + 1);

  const providerName =
    rawProvider.toLowerCase() === "google" ? "Google" :
    rawProvider.toLowerCase() === "microsoft" ? "Microsoft" :
    rawProvider;

  return { providerName, providerUserId };
}

async function findExistingUserByEmail(email) {
  const res = await client.send(
    new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter: `email = "${email}"`,
      Limit: 10,
    })
  );

  const users = res.Users ?? [];
  if (users.length === 0) return null;

  const primary = users.find((u) =>
    (u.Username ?? "").toLowerCase().startsWith(PRIMARY_IDP.toLowerCase() + "_")
  );

  return (primary?.Username ?? users[0].Username) ?? null;
}

async function destUserHasRequiredGroup(destUsername) {
  if (!REQUIRE_DEST_GROUP) return true;

  const res = await client.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: destUsername,
    })
  );

  const groups = (res.Groups ?? [])
    .map((g) => (g.GroupName ?? "").toLowerCase())
    .filter(Boolean);

  return groups.includes(REQUIRE_DEST_GROUP.toLowerCase());
}

export const handler = async (event) => {
  // Only external provider signups
  if (event.triggerSource !== "PreSignUp_ExternalProvider") {
    return event;
  }

  const email = event.request?.userAttributes?.email;
  if (!email) return event;

  const domain = getEmailDomain(email);
  if (ALLOWED_EMAIL_DOMAINS.length > 0 && !ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    return event;
  }

  const source = parseProviderFromUsername(event.userName);
  if (!source) return event;

  // If they signed in with the primary provider, just allow it
  if (source.providerName.toLowerCase() === PRIMARY_IDP.toLowerCase()) {
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
    return event;
  }

  const destUsername = await findExistingUserByEmail(email);
  if (!destUsername) {
    // No existing destination -> allow creation
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
    return event;
  }

  const ok = await destUserHasRequiredGroup(destUsername);
  if (!ok) {
    // Destination exists but isn't platform-approved; do not link
    return event;
  }

  // Link source identity into destination user
  await client.send(
    new AdminLinkProviderForUserCommand({
      UserPoolId: USER_POOL_ID,
      DestinationUser: {
        ProviderName: "Cognito",
        ProviderAttributeValue: destUsername,
      },
      SourceUser: {
        ProviderName: source.providerName,
        ProviderAttributeName: "Cognito_Subject",
        ProviderAttributeValue: source.providerUserId,
      },
    })
  );

  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
};
