output "r2_bucket_name" {
  description = "R2 bucket provisioned for ClipBR video assets."
  value       = cloudflare_r2_bucket.videos.name
}

output "r2_endpoint" {
  description = "S3-compatible endpoint for the provisioned R2 account."
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}

output "application_namespace" {
  description = "Kubernetes namespace containing the application release."
  value       = kubernetes_namespace_v1.application.metadata[0].name
}

output "helm_chart_version" {
  description = "Deployed Helm chart version."
  value       = helm_release.clipbr.version
}
