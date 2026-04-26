resource "ovh_cloud_project_kube_nodepool" "default" {
  service_name  = var.ovh_cloud_project_service
  kube_id       = var.cluster_id
  name          = "cip-default"
  flavor_name   = var.nodepool_flavor
  min_nodes     = var.nodepool_min_size
  max_nodes     = var.nodepool_max_size
  desired_nodes = var.nodepool_min_size
  autoscale     = false
}
