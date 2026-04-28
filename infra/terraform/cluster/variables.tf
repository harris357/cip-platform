variable "ovh_endpoint" {
  type    = string
  default = "ovh-ca"
}

variable "ovh_application_key" {
  type      = string
  sensitive = true
}

variable "ovh_application_secret" {
  type      = string
  sensitive = true
}

variable "ovh_consumer_key" {
  type      = string
  sensitive = true
}

variable "ovh_cloud_project_service" {
  type = string
}

variable "cluster_id" {
  type        = string
  description = "OVH cluster ID (from bootstrap outputs)"
}

variable "nodepool_flavor" {
  type    = string
  default = "b3-8"
}

variable "nodepool_min_size" {
  type    = number
  default = 1
}

variable "nodepool_max_size" {
  type    = number
  default = 1
}

variable "domain" {
  type        = string
  description = "Base domain for all ingress hostnames (e.g. dev.cip.idlevice.ca)"
  default     = "dev.cip.idlevice.ca"
}
