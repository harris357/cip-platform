# Module: ovh-cluster
# Provisions a managed Kubernetes cluster + default node pool on OVH Public Cloud.

terraform {
  required_providers {
    ovh = {
      source  = "ovh/ovh"
      version = "~> 0.40"
    }
  }
}

resource "ovh_cloud_project_kube" "cluster" {
  service_name = var.cloud_project_service
  name         = var.cluster_name
  region       = var.region
  version      = var.kubernetes_version
}

resource "ovh_cloud_project_kube_nodepool" "default" {
  service_name  = var.cloud_project_service
  kube_id       = ovh_cloud_project_kube.cluster.id
  name          = "${var.cluster_name}-default"
  flavor_name   = var.node_flavor
  desired_nodes = var.desired_nodes
  min_nodes     = var.min_nodes
  max_nodes     = var.max_nodes
  autoscale     = true
}

output "cluster_id" {
  description = "OVH cluster ID"
  value       = ovh_cloud_project_kube.cluster.id
}

output "kubeconfig" {
  description = "Kubeconfig for the provisioned cluster"
  value       = ovh_cloud_project_kube.cluster.kubeconfig
  sensitive   = true
}
