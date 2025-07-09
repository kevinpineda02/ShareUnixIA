 function toggleModal() {
    const modal = document.getElementById("infoModal");
    if (modal.style.display === "flex") {
      modal.style.display = "none";
    } else {
      modal.style.display = "flex";
    }
  }