locals {
  hostnames = {
    keycloak = "keycloak-${var.env_prefix}.${var.domain}"
    grafana  = "grafana-${var.env_prefix}.${var.domain}"
    langfuse = "langfuse-${var.env_prefix}.${var.domain}"
    bot      = "bot-${var.env_prefix}.${var.domain}"
    api      = "api-${var.env_prefix}.${var.domain}"
  }
}

resource "kubernetes_namespace" "cip_infra" {
  metadata { name = "cip-infra" }
}

resource "kubernetes_namespace" "cip_auth" {
  metadata { name = "cip-auth" }
}

resource "kubernetes_namespace" "cip_app" {
  metadata { name = "cip-app" }
}

resource "kubernetes_namespace" "cip_observe" {
  metadata { name = "cip-observe" }
}

resource "kubernetes_namespace" "ingress_nginx" {
  metadata { name = "ingress-nginx" }
}

resource "kubernetes_namespace" "cert_manager" {
  metadata { name = "cert-manager" }
}

# ── PVCs — Cinder volumes, created once, never destroyed ─────────────────────

resource "kubernetes_persistent_volume_claim" "postgres_data" {
  metadata {
    name      = "postgres-data"
    namespace = kubernetes_namespace.cip_infra.metadata[0].name
  }
  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = "csi-cinder-classic"
    resources { requests = { storage = "20Gi" } }
  }
  wait_until_bound = true
  lifecycle { prevent_destroy = true }
}

resource "kubernetes_persistent_volume_claim" "nats_data" {
  metadata {
    name      = "nats-data"
    namespace = kubernetes_namespace.cip_infra.metadata[0].name
  }
  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = "csi-cinder-classic"
    resources { requests = { storage = "5Gi" } }
  }
  wait_until_bound = true
  lifecycle { prevent_destroy = true }
}

resource "kubernetes_persistent_volume_claim" "keycloak_data" {
  metadata {
    name      = "keycloak-data"
    namespace = kubernetes_namespace.cip_auth.metadata[0].name
  }
  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = "csi-cinder-classic"
    resources { requests = { storage = "2Gi" } }
  }
  wait_until_bound = true
  lifecycle { prevent_destroy = true }
}

# ── ingress-nginx — OVH provisions a Floating IP for the LoadBalancer service ─

resource "helm_release" "ingress_nginx" {
  name             = "ingress-nginx"
  repository       = "https://kubernetes.github.io/ingress-nginx"
  chart            = "ingress-nginx"
  namespace        = kubernetes_namespace.ingress_nginx.metadata[0].name
  values           = [file("${path.module}/../../helm/ingress-nginx-values.yaml")]
  wait             = true
  timeout          = 300
}

# ── cert-manager — TLS certificates via Let's Encrypt DNS-01 (Cloudflare) ────

resource "helm_release" "cert_manager" {
  name       = "cert-manager"
  repository = "https://charts.jetstack.io"
  chart      = "cert-manager"
  namespace  = kubernetes_namespace.cert_manager.metadata[0].name

  set {
    name  = "installCRDs"
    value = "true"
  }

  wait    = true
  timeout = 300
}

# ── Infrastructure Helm charts ────────────────────────────────────────────────

resource "helm_release" "postgres" {
  name      = "postgres"
  chart     = "oci://registry-1.docker.io/bitnamicharts/postgresql"
  version   = "18.6.2"
  namespace = kubernetes_namespace.cip_infra.metadata[0].name
  values    = [file("${path.module}/../../helm/postgres-values.yaml")]
  depends_on = [kubernetes_persistent_volume_claim.postgres_data]
}

resource "helm_release" "nats" {
  name       = "nats"
  repository = "https://nats-io.github.io/k8s/helm/charts"
  chart      = "nats"
  namespace  = kubernetes_namespace.cip_infra.metadata[0].name
  values     = [file("${path.module}/../../helm/nats-values.yaml")]
  depends_on = [kubernetes_persistent_volume_claim.nats_data]
}

resource "helm_release" "keycloak" {
  name       = "keycloak"
  repository = "https://codecentric.github.io/helm-charts"
  chart      = "keycloakx"
  version    = "7.1.11"
  namespace  = kubernetes_namespace.cip_auth.metadata[0].name
  values     = [templatefile("${path.module}/../../helm/keycloak-values.yaml", { keycloak_host = local.hostnames.keycloak })]
  depends_on = [helm_release.ingress_nginx, helm_release.cert_manager, helm_release.postgres]
  timeout    = 600
  wait       = true
}

resource "helm_release" "monitoring" {
  name       = "monitoring"
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "kube-prometheus-stack"
  namespace  = kubernetes_namespace.cip_observe.metadata[0].name
  values     = [file("${path.module}/../../helm/monitoring-values.yaml")]
  depends_on = [helm_release.ingress_nginx, helm_release.cert_manager]

  set {
    name  = "grafana.ingress.enabled"
    value = "true"
  }
  set {
    name  = "grafana.ingress.ingressClassName"
    value = "nginx"
  }
  set {
    name  = "grafana.ingress.hosts[0]"
    value = local.hostnames.grafana
  }
  set {
    name  = "grafana.ingress.tls[0].secretName"
    value = "grafana-tls"
  }
  set {
    name  = "grafana.ingress.tls[0].hosts[0]"
    value = local.hostnames.grafana
  }
  set {
    name  = "grafana.ingress.annotations.cert-manager\\.io/cluster-issuer"
    value = "letsencrypt-prod"
  }
  set {
    name  = "grafana.ingress.annotations.nginx\\.ingress\\.kubernetes\\.io/whitelist-source-range"
    value = "198.48.243.13/32"
  }
}

# App charts (litellm, langfuse, hr-service, platform-core, teams-bot) are deployed via start.ts.
# Their Ingress resources are rendered by their own Helm charts when ingress.enabled=true.
