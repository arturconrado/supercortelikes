resource "cloudflare_r2_bucket" "videos" {
  account_id    = var.cloudflare_account_id
  name          = var.r2_bucket_name
  location      = var.r2_location
  jurisdiction  = var.r2_jurisdiction
  storage_class = "Standard"
}

resource "kubernetes_namespace_v1" "application" {
  metadata {
    name = "clipbr"
    labels = {
      "app.kubernetes.io/part-of"          = "clipbr"
      "pod-security.kubernetes.io/enforce" = "restricted"
      "pod-security.kubernetes.io/audit"   = "restricted"
      "pod-security.kubernetes.io/warn"    = "restricted"
    }
  }
}

resource "kubernetes_resource_quota_v1" "application" {
  metadata {
    name      = "clipbr-compute"
    namespace = kubernetes_namespace_v1.application.metadata[0].name
  }
  spec {
    hard = {
      "requests.cpu"    = "8"
      "requests.memory" = "16Gi"
      "limits.cpu"      = "32"
      "limits.memory"   = "48Gi"
      "pods"            = "30"
    }
  }
}

resource "kubernetes_limit_range_v1" "application" {
  metadata {
    name      = "clipbr-defaults"
    namespace = kubernetes_namespace_v1.application.metadata[0].name
  }
  spec {
    limit {
      type = "Container"
      default = {
        cpu    = "1"
        memory = "1Gi"
      }
      default_request = {
        cpu    = "100m"
        memory = "256Mi"
      }
    }
  }
}

resource "helm_release" "clipbr" {
  name             = "clipbr"
  namespace        = kubernetes_namespace_v1.application.metadata[0].name
  chart            = "${path.module}/../helm/clipbr"
  atomic           = true
  cleanup_on_fail  = true
  create_namespace = false
  timeout          = 900
  wait             = true
  wait_for_jobs    = true

  values = [
    yamlencode({
      fullnameOverride = "clipbr-api"
      image = {
        repository = var.image_repository
        tag        = var.image_tag
      }
      migrationImage = {
        repository = var.migration_image_repository
        tag        = var.image_tag
      }
      imagePullSecrets = [for name in var.image_pull_secret_names : { name = name }]
      existingSecret   = var.application_secret_name
      config = {
        s3Endpoint = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
        s3Region   = "auto"
        s3Bucket   = cloudflare_r2_bucket.videos.name
      }
      networkPolicy = {
        databaseCidrs      = var.database_cidrs
        redisCidrs         = var.redis_cidrs
        objectStorageCidrs = var.object_storage_cidrs
      }
    })
  ]

  depends_on = [
    kubernetes_limit_range_v1.application,
    kubernetes_resource_quota_v1.application,
  ]
}
