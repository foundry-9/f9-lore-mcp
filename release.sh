#!/bin/bash
set -e  # Exit on error

VERSION=$(node -p "require('./manifest.json').version")

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
  echo "Error: Uncommitted changes exist. Please commit or stash them first."
  exit 1
fi

# Check if tag already exists
if git rev-parse "$VERSION" >/dev/null 2>&1; then
  echo "Error: Tag $VERSION already exists."
  exit 1
fi

# Build the project
echo "Building version $VERSION..."
npm run build

# Create and push the tag
echo "Creating tag $VERSION..."
git tag -a "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"

# Create GitHub release with the required assets
echo "Creating GitHub release..."
gh release create "$VERSION" main.js manifest.json styles.css --title "v$VERSION" --generate-notes

echo "Release $VERSION created successfully!"
