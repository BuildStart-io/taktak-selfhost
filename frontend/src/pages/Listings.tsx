import ListingsTable from "@/components/admin/ListingsTable";

const Listings = () => {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Listings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage marketplace product listings</p>
      </div>
      <ListingsTable />
    </div>
  );
};

export default Listings;
