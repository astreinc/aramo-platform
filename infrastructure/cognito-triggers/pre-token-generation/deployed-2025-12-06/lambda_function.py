def handler(event, context):
    acct = event["request"]["userAttributes"].get("custom:account_id")
    if acct:
        event["response"]["claimsAndScopeOverrideDetails"] = {
            "accessTokenGeneration": {
                "claimsToAddOrOverride": {"account_id": acct}
            }
        }
    return event
