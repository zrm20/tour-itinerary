# Start with a modular monolith

Build the initial backend as one deployable application with clear internal modules for organizations, tour access, and itineraries. Keep authorization and business rules outside GraphQL resolvers so the API delegates to application logic. This keeps the backend straightforward to operate and review, accepting that its modules will be deployed and scaled together rather than as independently deployed services.
