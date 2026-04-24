# Module: ovh-cluster
# Provisions a managed Kubernetes cluster on OVH Public Cloud (Managed Kubernetes Service).
#
# Resources this module will implement (stubs — not yet created):
#
#   ovh_cloud_project_kube — the managed K8s cluster
#     - region: var.region
#     - version: var.kubernetes_version
#     - name: var.cluster_name
#
#   ovh_cloud_project_kube_nodepool — the default worker node pool
#     - cluster_id: ovh_cloud_project_kube.cluster.id
#     - flavor_name: var.node_flavor (e.g. "b3-8")
#     - desired_nodes: var.desired_nodes
#     - min_nodes: var.min_nodes
#     - max_nodes: var.max_nodes
#     - autoscale: true
#
# Outputs: cluster_id, kubeconfig (sensitive)

terraform {
  required_providers {
    ovh = {
      source  = "ovh/ovh"
      version = "~> 0.40"
    }
  }
}

# TODO: implement ovh_cloud_project_kube resource
# TODO: implement ovh_cloud_project_kube_nodepool resource
