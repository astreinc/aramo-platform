output "user_name" {
  description = "App-principal IAM user name. Generate an access key for it out-of-band (aws iam create-access-key) and store in the secret store; never commit the secret."
  value       = aws_iam_user.this.name
}

output "user_arn" {
  description = "App-principal IAM user ARN."
  value       = aws_iam_user.this.arn
}
