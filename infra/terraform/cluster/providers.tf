terraform {
  required_version = ">= 1.6.0"
  required_providers {
    ovh = {
      source  = "ovh/ovh"
      version = "~> 0.40"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.27"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.12"
    }
  }
}

provider "ovh" {
  endpoint           = var.ovh_endpoint
  application_key    = var.ovh_application_key
  application_secret = var.ovh_application_secret
  consumer_key       = var.ovh_consumer_key
}

data "ovh_cloud_project_kube" "cluster" {
  service_name = var.ovh_cloud_project_service
  kube_id      = var.cluster_id
}

locals {
  kube_parsed  = yamldecode(data.ovh_cloud_project_kube.cluster.kubeconfig)
  kube_cluster = local.kube_parsed.clusters[0].cluster
  kube_user    = local.kube_parsed.users[0].user
}

provider "kubernetes" {
  host                   = local.kube_cluster.server
  cluster_ca_certificate = base64decode(local.kube_cluster["certificate-authority-data"])
  client_certificate     = base64decode(local.kube_user["client-certificate-data"])
  client_key             = base64decode(local.kube_user["client-key-data"])
}

provider "helm" {
  kubernetes {
    host                   = local.kube_cluster.server
    cluster_ca_certificate = base64decode(local.kube_cluster["certificate-authority-data"])
    client_certificate     = base64decode(local.kube_user["client-certificate-data"])
    client_key             = base64decode(local.kube_user["client-key-data"])
  }
}
