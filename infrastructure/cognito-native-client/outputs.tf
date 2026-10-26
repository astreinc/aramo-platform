# The client id is a public identifier (it ships inside the mobile app), not a
# secret. It becomes SIGN_NATIVE_COGNITO_CLIENT_ID in the box .env (P-7) and
# EXPO_PUBLIC_SIGN_NATIVE_CLIENT_ID in the app build, each separately authorized.
output "aramo_sign_native_client_id" {
  description = "Client id of the aramo-sign-native public app client."
  value       = aws_cognito_user_pool_client.aramo_sign_native.id
}
