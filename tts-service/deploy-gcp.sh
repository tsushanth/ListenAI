#!/bin/bash
# Deploy ReadAloud AI TTS Service to GCP
#
# This script sets up a GPU-enabled VM running the TTS service.
# Options:
#   1. GCE VM with GPU (most cost-effective for consistent load)
#   2. Cloud Run with GPU (auto-scaling, pay per request)

set -e

# ============================================================================
# Configuration
# ============================================================================

PROJECT_ID="${GCP_PROJECT_ID:-your-project-id}"
REGION="${GCP_REGION:-us-central1}"
ZONE="${GCP_ZONE:-us-central1-a}"
SERVICE_NAME="readaloud-tts"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# VM Configuration
VM_NAME="tts-gpu-vm"
MACHINE_TYPE="n1-standard-4"  # 4 vCPUs, 15GB RAM
GPU_TYPE="nvidia-tesla-t4"    # T4 is cost-effective for inference
GPU_COUNT=1

# ============================================================================
# Functions
# ============================================================================

print_header() {
    echo ""
    echo "========================================"
    echo "$1"
    echo "========================================"
    echo ""
}

# ============================================================================
# Build and Push Docker Image
# ============================================================================

build_image() {
    print_header "Building Docker Image"

    # Configure Docker for GCR
    gcloud auth configure-docker gcr.io --quiet

    # Build the image
    docker build -t ${IMAGE_NAME}:latest .

    # Push to GCR
    docker push ${IMAGE_NAME}:latest

    echo "Image pushed to ${IMAGE_NAME}:latest"
}

# ============================================================================
# Option 1: Deploy to GCE VM with GPU
# ============================================================================

deploy_to_gce() {
    print_header "Deploying to GCE VM with GPU"

    # Check if VM exists
    if gcloud compute instances describe ${VM_NAME} --zone=${ZONE} --project=${PROJECT_ID} &>/dev/null; then
        echo "VM ${VM_NAME} already exists. Updating..."

        # Update the container
        gcloud compute instances update-container ${VM_NAME} \
            --zone=${ZONE} \
            --project=${PROJECT_ID} \
            --container-image=${IMAGE_NAME}:latest
    else
        echo "Creating new VM ${VM_NAME}..."

        # Create VM with GPU and Container-Optimized OS
        gcloud compute instances create-with-container ${VM_NAME} \
            --project=${PROJECT_ID} \
            --zone=${ZONE} \
            --machine-type=${MACHINE_TYPE} \
            --accelerator=type=${GPU_TYPE},count=${GPU_COUNT} \
            --maintenance-policy=TERMINATE \
            --restart-on-failure \
            --boot-disk-size=100GB \
            --boot-disk-type=pd-ssd \
            --container-image=${IMAGE_NAME}:latest \
            --container-restart-policy=always \
            --container-privileged \
            --container-env=PORT=8080,CACHE_ENABLED=true \
            --container-mount-host-path=host-path=/mnt/disks/cache,mount-path=/app/audio_cache \
            --tags=tts-server,http-server \
            --scopes=cloud-platform

        # Install NVIDIA drivers
        gcloud compute ssh ${VM_NAME} --zone=${ZONE} --command="sudo cos-extensions install gpu"
    fi

    # Create firewall rule for TTS service
    if ! gcloud compute firewall-rules describe allow-tts-8080 --project=${PROJECT_ID} &>/dev/null; then
        gcloud compute firewall-rules create allow-tts-8080 \
            --project=${PROJECT_ID} \
            --allow=tcp:8080 \
            --target-tags=tts-server \
            --description="Allow TTS service traffic"
    fi

    # Get external IP
    EXTERNAL_IP=$(gcloud compute instances describe ${VM_NAME} \
        --zone=${ZONE} \
        --project=${PROJECT_ID} \
        --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

    echo ""
    echo "TTS Service deployed!"
    echo "URL: http://${EXTERNAL_IP}:8080"
    echo "Health: http://${EXTERNAL_IP}:8080/health"
}

# ============================================================================
# Option 2: Deploy to Cloud Run with GPU (Preview)
# ============================================================================

deploy_to_cloud_run() {
    print_header "Deploying to Cloud Run with GPU"

    # Note: Cloud Run GPU support is in preview and may require allowlisting
    gcloud run deploy ${SERVICE_NAME} \
        --project=${PROJECT_ID} \
        --region=${REGION} \
        --image=${IMAGE_NAME}:latest \
        --platform=managed \
        --cpu=4 \
        --memory=16Gi \
        --gpu=1 \
        --gpu-type=nvidia-l4 \
        --min-instances=0 \
        --max-instances=5 \
        --timeout=300 \
        --concurrency=10 \
        --port=8080 \
        --allow-unauthenticated \
        --set-env-vars="CACHE_ENABLED=true,LOG_LEVEL=INFO"

    # Get the service URL
    SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} \
        --project=${PROJECT_ID} \
        --region=${REGION} \
        --format='value(status.url)')

    echo ""
    echo "TTS Service deployed to Cloud Run!"
    echo "URL: ${SERVICE_URL}"
    echo "Health: ${SERVICE_URL}/health"
}

# ============================================================================
# Option 3: Deploy to GKE with GPU Node Pool
# ============================================================================

deploy_to_gke() {
    print_header "Deploying to GKE with GPU"

    CLUSTER_NAME="readaloud-cluster"

    # Check if cluster exists, create if not
    if ! gcloud container clusters describe ${CLUSTER_NAME} --zone=${ZONE} --project=${PROJECT_ID} &>/dev/null; then
        echo "Creating GKE cluster..."

        gcloud container clusters create ${CLUSTER_NAME} \
            --project=${PROJECT_ID} \
            --zone=${ZONE} \
            --num-nodes=1 \
            --machine-type=e2-standard-2

        # Add GPU node pool
        gcloud container node-pools create gpu-pool \
            --project=${PROJECT_ID} \
            --cluster=${CLUSTER_NAME} \
            --zone=${ZONE} \
            --machine-type=n1-standard-4 \
            --accelerator=type=${GPU_TYPE},count=1 \
            --num-nodes=1 \
            --min-nodes=0 \
            --max-nodes=3 \
            --enable-autoscaling
    fi

    # Get credentials
    gcloud container clusters get-credentials ${CLUSTER_NAME} --zone=${ZONE} --project=${PROJECT_ID}

    # Install NVIDIA GPU device plugin
    kubectl apply -f https://raw.githubusercontent.com/GoogleCloudPlatform/container-engine-accelerators/master/nvidia-driver-installer/cos/daemonset-preloaded.yaml

    # Apply Kubernetes deployment
    cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tts-service
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tts-service
  template:
    metadata:
      labels:
        app: tts-service
    spec:
      containers:
      - name: tts
        image: ${IMAGE_NAME}:latest
        ports:
        - containerPort: 8080
        resources:
          limits:
            nvidia.com/gpu: 1
        env:
        - name: PORT
          value: "8080"
        - name: CACHE_ENABLED
          value: "true"
      nodeSelector:
        cloud.google.com/gke-accelerator: nvidia-tesla-t4
---
apiVersion: v1
kind: Service
metadata:
  name: tts-service
spec:
  type: LoadBalancer
  ports:
  - port: 80
    targetPort: 8080
  selector:
    app: tts-service
EOF

    echo "Waiting for external IP..."
    sleep 30

    EXTERNAL_IP=$(kubectl get svc tts-service -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
    echo ""
    echo "TTS Service deployed to GKE!"
    echo "URL: http://${EXTERNAL_IP}"
}

# ============================================================================
# Cost Estimates
# ============================================================================

show_cost_estimates() {
    print_header "Cost Estimates (US Central)"

    echo "Option 1: GCE VM with T4 GPU"
    echo "  - n1-standard-4: ~\$97/month"
    echo "  - T4 GPU: ~\$257/month"
    echo "  - Total: ~\$354/month (always on)"
    echo "  - With committed use: ~\$248/month"
    echo ""
    echo "Option 2: Cloud Run with L4 GPU"
    echo "  - ~\$0.000463/vCPU-second"
    echo "  - ~\$0.00253/GPU-second"
    echo "  - Cost depends on usage"
    echo "  - Good for bursty workloads"
    echo ""
    echo "Option 3: GKE with T4 GPU (autoscaling)"
    echo "  - Base: ~\$150/month (small control plane)"
    echo "  - GPU nodes: ~\$354/month per node"
    echo "  - Scales 0-N based on demand"
    echo ""
    echo "Recommendation:"
    echo "  - Start with GCE VM for predictable costs"
    echo "  - Move to GKE if you need autoscaling"
}

# ============================================================================
# Main
# ============================================================================

case "${1:-}" in
    build)
        build_image
        ;;
    gce)
        build_image
        deploy_to_gce
        ;;
    cloudrun)
        build_image
        deploy_to_cloud_run
        ;;
    gke)
        build_image
        deploy_to_gke
        ;;
    costs)
        show_cost_estimates
        ;;
    *)
        echo "ReadAloud AI TTS Service Deployment"
        echo ""
        echo "Usage: $0 <command>"
        echo ""
        echo "Commands:"
        echo "  build     - Build and push Docker image"
        echo "  gce       - Deploy to GCE VM with GPU (recommended for start)"
        echo "  cloudrun  - Deploy to Cloud Run with GPU"
        echo "  gke       - Deploy to GKE with GPU node pool"
        echo "  costs     - Show cost estimates"
        echo ""
        echo "Environment variables:"
        echo "  GCP_PROJECT_ID - Your GCP project ID"
        echo "  GCP_REGION     - GCP region (default: us-central1)"
        echo "  GCP_ZONE       - GCP zone (default: us-central1-a)"
        ;;
esac
