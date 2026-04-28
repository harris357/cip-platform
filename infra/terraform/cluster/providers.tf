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

provider "kubernetes" {
  config_path    = pathexpand("~/.kube/cip-dev.yaml")
  config_context = "kubernetes-admin@cip-dev"
}

provider "helm" {
  kubernetes {
    config_path    = pathexpand("~/.kube/cip-dev.yaml")
    config_context = "kubernetes-admin@cip-dev"
  }
}
