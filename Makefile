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

## Run locally with .env
dev:
	docker compose up --build

## Stop running container
stop:
	docker compose down

## Remove local image
clean:
	docker rmi $(IMAGE):$(VERSION) $(IMAGE):latest || true
