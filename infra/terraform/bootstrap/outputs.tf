output "cluster_id" {
  description = "OVH Managed Kubernetes cluster ID"
  value       = ovh_cloud_project_kube.cip.id
}

output "kubeconfig_path" {
  description = "Path to kubeconfig written by bootstrap"
  value       = "~/.kube/cip-dev.yaml"
}

output "kubeconfig" {
  description = "Kubeconfig for the CIP cluster — write to kubeconfig_path"
  value       = ovh_cloud_project_kube.cip.kubeconfig
  sensitive   = true
}
