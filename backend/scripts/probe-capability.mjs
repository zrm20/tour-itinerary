// Reviewed health-only image from the completed bootstrap checkpoint (#14).
// Missing labels on any other image are an explicit recovery error.
const legacy = {
  commit: 'c66dcb693ba3fa6a683e81a946d6be5e8880796e',
  image:
    'us-east4-docker.pkg.dev/tour-itinerary-513414/tour-itinerary/api@sha256:26fcbf17ece404d46baefea25f3d2ffae4308ab65c4be094413b1561fb9588ef',
};

export function probeCapability(image, commit, labels) {
  if (labels?.['org.opencontainers.image.revision'] !== commit)
    throw new Error(
      'Recovery metadata inconsistent: image commit differs from captured revision',
    );
  const capability = labels?.['dev.tour-itinerary.probe'];
  if (capability === 'graphql-v1') return true;
  if (capability === 'health-v1') return false;
  if (
    capability === undefined &&
    image === legacy.image &&
    commit === legacy.commit
  )
    return false;
  throw new Error(
    'Recovery capability metadata missing or invalid; reconcile the captured revision/image before release',
  );
}
