export interface GigaCrewService {
    serviceId: string;
    title: string;
    description: string;
    communicationChannel: string;
    provider: string;
}

export interface GigaCrewNegotiationResult {
    orderId: string;
    proposalExpiry: number;
    terms: string;
    price: string;
    deadline: number;
    proposalSignature: string;
}
