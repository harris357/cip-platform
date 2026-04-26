output "nodepool_id" {
  description = "OVH node pool ID — used by infra package scale scripts"
  value       = ovh_cloud_project_kube_nodepool.default.id
}
