output "cluster_id" {
  description = "OVH Managed Kubernetes cluster ID"
  value       = "" # TODO: reference cluster resource
}

output "kubeconfig_path" {
  description = "Path to kubeconfig written by bootstrap"
  value       = "~/.kube/cip-dev.yaml"
}
