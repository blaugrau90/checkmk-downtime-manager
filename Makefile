IMAGE  := blaugrau90/checkmk-downtime-manager
VERSION := $(shell node -p "require('./package.json').version")

.PHONY: build push release dev stop clean

## Build Docker image (version + latest tag)
build:
	docker build -t $(IMAGE):$(VERSION) -t $(IMAGE):latest .

## Push image to Docker Hub
push:
	docker push $(IMAGE):$(VERSION)
	docker push $(IMAGE):latest

## Build + push in one step
release: build push

## Build and run locally (builds from source, does not use published image)
dev:
	docker build -t $(IMAGE):latest . && docker compose up

## Stop running container
stop:
	docker compose down

## Remove local image
clean:
	docker rmi $(IMAGE):$(VERSION) $(IMAGE):latest || true
