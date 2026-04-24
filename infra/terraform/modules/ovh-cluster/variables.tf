variable "cloud_project_service" {
  type        = string
  description = "OVH Cloud project service name"
}

variable "region" {
  type        = string
  description = "OVH region (e.g. BHS5, GRA9)"
  default     = "BHS5"
}

variable "cluster_name" {
  type        = string
  description = "Name of the managed Kubernetes cluster"
  default     = "cip-dev"
}

variable "kubernetes_version" {
  type        = string
  description = "Kubernetes version to use (e.g. '1.29')"
  default     = "1.29"
}

variable "node_flavor" {
  type        = string
  description = "OVH instance flavor for worker nodes (e.g. b3-8)"
  default     = "b3-8"
}

variable "desired_nodes" {
  type        = number
  description = "Initial node count"
  default     = 1
}

variable "min_nodes" {
  type        = number
  description = "Minimum nodes for autoscaler"
  default     = 0
}

variable "max_nodes" {
  type        = number
  description = "Maximum nodes for autoscaler"
  default     = 3
}
